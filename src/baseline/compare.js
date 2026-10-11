'use strict';
/**
 * A/B comparison: baseline LLM browser agent (no Doorman) vs Doorman on the same site and goals, from an identical start.
 * CLI: node src/baseline/compare.js --base http://localhost:3000 --split heldout --limit 10 --concurrency 2
 *        [--kinds add_to_cart,find,place_order,view_order] [--possible-only] [--max-steps 12]
 * Writes data/compare.json and inserts the same doc into the `comparisons` collection when a db is configured.
 * Baseline cost is MEASURED from token usage; Doorman cost is ESTIMATED with the same assumptions as server.js /api/analytics.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { runBaselineGoal, prepareFreshShopPage } = require('./agent');
const { runGoal } = require('../sim/agent');
const { loadGoals, pool, SITE_ID } = require('../sim/run');
const { verify } = require('../sim/verify');
const { toVerifySpec } = require('../sim/goals');
const { PRICES } = require('../lib/llm');

const OUT_FILE = path.join(__dirname, '..', '..', 'data', 'compare.json');
// Same assumptions as server.js /api/analytics `cost` block (keep in sync).
const COST_ASSUMPTIONS = { jevTokensPerStep: 1500, jevUsdPerMTokens: 0.042, llmInputTokensPerStep: 2000, llmOutputTokensPerStep: 150 };

/** Estimate a Doorman visit's inference cost from its tier counts (server.js formula). */
function estimateDoormanCost(tierCounts = {}, model) {
  const [pIn, pOut] = PRICES[model] || [1, 5];
  const A = COST_ASSUMPTIONS;
  const llmSteps = tierCounts.T2_llm || 0, jevCalls = (tierCounts.T1_jev || 0) + llmSteps;
  const jevUsd = jevCalls * A.jevTokensPerStep * A.jevUsdPerMTokens / 1e6;
  const llmUsd = llmSteps * (A.llmInputTokensPerStep * pIn + A.llmOutputTokensPerStep * pOut) / 1e6;
  return { llmCalls: llmSteps, jevCalls, jevUsd, llmUsd, costUsdEstimate: jevUsd + llmUsd };
}

const EMPTY_STATE = { cart: [], orders: [], loggedIn: false, viewedOrders: [], lastError: null, events: [] };

/** Run the baseline agent on one goal in a fresh context and verify objectively. */
async function runBaselineOnGoal({ goal, baseUrl, browser, llm, maxSteps, log }) {
  const context = await browser.newContext();
  let r = { done: false, impossibleReported: false, steps: [], stepCount: 0, llmCalls: 0, promptTokens: 0, completionTokens: 0, llmCostUsd: 0, ms: 0, stoppedBecause: 'error' };
  let state = EMPTY_STATE, error = null, page;
  const t0 = Date.now();
  try {
    page = await prepareFreshShopPage({ context, baseUrl });
    r = await runBaselineGoal({ goalText: goal.text, page, llm, maxSteps, log });
    state = await page.evaluate(() => window.shopState());
  } catch (e) { error = e; log('baseline-error', { goalId: goal.id, error: e.message }); }
  await context.close().catch(() => {});
  const v = verify(toVerifySpec(goal), state, !!r.impossibleReported);
  return {
    success: !!v.success, failureKind: v.failureKind, reason: error && !v.success ? `${v.reason || 'ERROR'}: ${error.message}` : v.reason,
    ms: r.ms || (Date.now() - t0), steps: r.stepCount, llmCalls: r.llmCalls, tokens: { prompt: r.promptTokens, completion: r.completionTokens },
    costUsd: +r.llmCostUsd.toFixed(6), costMeasured: true, stoppedBecause: r.stoppedBecause, done: r.done, impossibleReported: r.impossibleReported,
    actions: r.steps.map((s) => ({ action: s.action, ref: s.ref, value: s.value, result: s.result, llmMs: s.llmMs })),
  };
}

const median = (xs) => { const a = xs.slice().sort((x, y) => x - y); return a.length ? (a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2) : null; };
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const r3 = (x) => (x == null ? null : +Number(x).toFixed(3));

function aggregateSide(rows, key) {
  const xs = rows.map((g) => g[key]);
  const out = {
    successRate: r3(mean(xs.map((x) => (x.success ? 1 : 0)))), medianMs: median(xs.map((x) => x.ms)), meanMs: Math.round(mean(xs.map((x) => x.ms)) || 0),
    meanSteps: r3(mean(xs.map((x) => x.steps))), totalLlmCalls: xs.reduce((a, x) => a + (x.llmCalls || 0), 0),
    totalCostUsd: +xs.reduce((a, x) => a + (x.costUsd ?? x.costUsdEstimate ?? 0), 0).toFixed(6),
  };
  const poss = rows.filter((g) => g.possible), imp = rows.filter((g) => !g.possible);
  out.successPossible = r3(mean(poss.map((g) => (g[key].success ? 1 : 0))));
  out.impossibleHandled = r3(mean(imp.map((g) => (g[key].success ? 1 : 0))));
  if (key === 'doorman') out.totalJevCalls = xs.reduce((a, x) => a + (x.jevCalls || 0), 0);
  return out;
}

/**
 * Run the comparison.
 * @param {{ deps:object, baseUrl:string, split?:string, limit?:number, concurrency?:number, kinds?:string[], possibleOnly?:boolean, maxSteps?:number, browser?:object }} args
 */
async function compare({ deps, baseUrl, split = 'heldout', limit, concurrency = 2, kinds, possibleOnly = false, maxSteps = 12, browser } = {}) {
  if (!baseUrl) throw new Error('compare: baseUrl required');
  const log = deps?.log || (() => {});
  let list = await loadGoals({ deps });
  if (split !== 'all') list = list.filter((g) => g.split === split);
  if (kinds?.length) list = list.filter((g) => kinds.includes(g.kind));
  if (possibleOnly) list = list.filter((g) => g.possible);
  if (limit) list = list.slice(0, limit);
  const model = deps.llm?.model || process.env.NEON_MODEL || 'gpt-5-4-mini';
  const runId = crypto.randomUUID(), startedAt = new Date().toISOString();
  const own = !browser;
  if (own) browser = await require('playwright').chromium.launch();
  let goals;
  try {
    goals = await pool(list, concurrency, async (goal, i) => {
      const baseline = await runBaselineOnGoal({ goal, baseUrl, browser, llm: deps.llm, maxSteps, log });
      const d = await runGoal({ goal, baseUrl, browser, deps }); // Doorman keeps its bench defaults (maxSteps 8 + config guardrails)
      const est = estimateDoormanCost(d.tierCounts, model);
      const doorman = { success: d.success, failureKind: d.failureKind, reason: d.reason, ms: d.ms, steps: d.steps, llmCalls: est.llmCalls, jevCalls: est.jevCalls,
        costUsdEstimate: +est.costUsdEstimate.toFixed(6), costEstimated: true, tierCounts: d.tierCounts, impossibleReported: d.impossibleReported, visitId: d.visitId };
      const row = { goalId: goal.id, kind: goal.kind, text: goal.text, possible: !!goal.possible, flaw: goal.flaw || null, baseline, doorman };
      log('compare-goal', { i: i + 1, of: list.length, id: goal.id, baseline: baseline.success, doorman: doorman.success, bMs: baseline.ms, dMs: doorman.ms, bSteps: baseline.steps, dSteps: doorman.steps });
      return row;
    });
  } finally { if (own) await browser.close().catch(() => {}); }
  const doc = {
    runId, siteId: SITE_ID, baseUrl, split, startedAt, finishedAt: new Date().toISOString(), model,
    costAssumptions: { doorman: { kind: 'estimate', ...COST_ASSUMPTIONS, priceUsdPerMTokens: PRICES[model] || [1, 5] }, baseline: { kind: 'measured', priceUsdPerMTokens: PRICES[model] || [1, 5] } },
    goals, aggregate: { n: goals.length, baseline: aggregateSide(goals, 'baseline'), doorman: aggregateSide(goals, 'doorman') },
  };
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(doc, null, 1));
  if (deps?.db) await deps.db.col('comparisons').insertOne({ ...doc });
  return doc;
}

/** Plain-text aggregate table for stdout. */
function formatTable(doc) {
  const { baseline: b, doorman: d, n } = doc.aggregate;
  const pct = (x) => (x == null ? '   -' : `${Math.round(x * 100)}%`.padStart(4));
  const rows = [
    ['metric', 'baseline', 'doorman'],
    ['success rate', pct(b.successRate), pct(d.successRate)],
    ['success (possible)', pct(b.successPossible), pct(d.successPossible)],
    ['impossible handled', pct(b.impossibleHandled), pct(d.impossibleHandled)],
    ['median ms', String(b.medianMs ?? '-'), String(d.medianMs ?? '-')],
    ['mean ms', String(b.meanMs ?? '-'), String(d.meanMs ?? '-')],
    ['mean steps', String(b.meanSteps ?? '-'), String(d.meanSteps ?? '-')],
    ['LLM calls (total)', String(b.totalLlmCalls), String(d.totalLlmCalls)],
    ['Jev calls (total)', '-', String(d.totalJevCalls)],
    ['cost USD (total)', `$${b.totalCostUsd} (measured)`, `$${d.totalCostUsd} (estimated)`],
  ];
  const w = [0, 1, 2].map((c) => Math.max(...rows.map((r) => r[c].length)));
  const line = (r) => r.map((c, i) => c.padEnd(w[i])).join('  ');
  return [`A/B on ${n} goals (${doc.split}), model ${doc.model}, run ${doc.runId}`, line(rows[0]), w.map((x) => '-'.repeat(x)).join('  '), ...rows.slice(1).map(line)].join('\n');
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (a.startsWith('--')) { const k = a.slice(2); const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true'; out[k] = v; } }
  return out;
}

module.exports = { compare, estimateDoormanCost, aggregateSide, formatTable, COST_ASSUMPTIONS, OUT_FILE };

if (require.main === module) {
  (async () => {
    require('../lib/env');
    const a = parseArgs(process.argv.slice(2));
    const base = a.base || process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
    const deps = await require('../lib').makeDeps(process.env); // baseline needs the real LLM: no fake fallback here
    deps.log = (ev, d) => {
      if (ev === 'compare-goal') console.error(`[${d.i}/${d.of}] ${d.id}  baseline ${d.baseline ? 'ok  ' : 'FAIL'} ${d.bMs}ms/${d.bSteps}st  doorman ${d.doorman ? 'ok  ' : 'FAIL'} ${d.dMs}ms/${d.dSteps}st`);
      else if (/error/.test(ev)) console.error(ev, JSON.stringify(d));
    };
    const doc = await compare({ deps, baseUrl: base, split: a.split || 'heldout', limit: a.limit ? Number(a.limit) : undefined, concurrency: Number(a.concurrency) || 2,
      kinds: a.kinds ? a.kinds.split(',').map((s) => s.trim()).filter(Boolean) : undefined, possibleOnly: a['possible-only'] === 'true', maxSteps: a['max-steps'] ? Number(a['max-steps']) : 12 });
    console.log(formatTable(doc));
    console.log(`wrote ${OUT_FILE}`);
    if (deps.db?.close) await deps.db.close();
  })().catch((e) => { console.error(e); process.exit(1); });
}
