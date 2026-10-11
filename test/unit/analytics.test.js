'use strict';
// GET /api/analytics computes everything from the DB; /dashboard/ and /evolution/ serve HTML.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../../server');
const { makeFakeDeps } = require('../../src/lib');
const { PRICES } = require('../../src/lib/llm');

const SITE = 'trailhead';
const step = (tier, action = 'x') => ({ action, params: {}, tier, confidence: 0.9, outcome: 'ok', messagesAfter: [] });
const visit = (i, { goal, outcome, failureReason = null, ms, tiers, configVersion = 1 }) => {
  const history = tiers.map((t) => step(t));
  const tierCounts = {}; for (const t of tiers) tierCounts[t] = (tierCounts[t] || 0) + 1;
  return { siteId: SITE, visitId: `v${i}`, goal, goalEmbedding: null, history, outcome, failureReason, ms, tierCounts, steps: history.length, configVersion, agentReported: { done: outcome === 'success', impossible: outcome === 'impossible' }, createdAt: new Date(Date.UTC(2026, 9, 10, 12, i)).toISOString() };
};

/** A handful of realistic goals, configs, runs and visits. Returns the expected numbers the assertions use. */
async function seed(deps) {
  const goals = [
    { id: 'g1', siteId: SITE, kind: 'add_to_cart', params: { productId: 'road-racer', size: 9 }, possible: true, flaw: null, split: 'heldout', text: 'Add the Road Racer in size 9 to my cart.' },
    { id: 'g2', siteId: SITE, kind: 'add_to_cart', params: { productId: 'trail-runner', size: 10 }, possible: false, flaw: 'A', split: 'train', text: 'Put a Trail Runner, size 10, in the cart.' },
    { id: 'g3', siteId: SITE, kind: 'place_order', params: { productId: 'rain-shell', size: 'M', zip: '94110' }, possible: false, flaw: 'B', split: 'heldout', text: 'Order the Rain Shell in M shipped to 94110.' },
    { id: 'g4', siteId: SITE, kind: 'find', params: { productId: 'wool-socks' }, possible: true, flaw: null, split: 'train', text: 'Find the wool socks product page.' },
    { id: 'g5', siteId: SITE, kind: 'impossible', params: { topic: 'vegan hiking boots' }, possible: false, flaw: 'D', split: 'heldout', text: 'I want vegan hiking boots.' },
  ];
  await deps.db.col('goals').insertMany(goals);
  const base = { siteId: SITE, tools: {}, context: { includeMessages: true, includeItems: true, maxItems: 12, historySteps: 4, recipesTopK: 3, recipeMinScore: 0.88 }, jev: { nextInstructions: 'Choose the single action.', confidenceThreshold: 0.7 }, guardrails: { confirm: ['place_order'], maxSteps: 8, impossibleThreshold: 0.8 } };
  const m = (successPossible, impossibleHandled, medianMs, llmFallbackRate, recipeHitRate, n = 12) => ({ n, successPossible, impossibleHandled, medianMs, p90Ms: medianMs * 1.8, llmFallbackRate, recipeHitRate, avgSteps: 3.1, byFlaw: {}, byKind: {} });
  const v1 = { ...base, version: 1, parent: null, active: false, createdBy: 'seed', rules: [], eval: { heldout: m(0.58, 0.5, 4100, 0.31, 0) }, patch: null, verdict: null, rationale: null, createdAt: '2026-10-10T10:00:00.000Z' };
  const v2 = { ...base, version: 2, parent: 1, active: true, createdBy: 'editor', rules: ['If an alert says a size is out of stock, report the goal as impossible instead of retrying.'],
    tools: { add_to_cart: { exposed: true, description: 'Adds the product currently shown, in the selected size, to the cart.' } },
    patch: [{ op: 'add', path: '/tools/add_to_cart/description', value: 'Adds the product currently shown, in the selected size, to the cart.' }, { op: 'add', path: '/rules/-', value: 'If an alert says a size is out of stock, report the goal as impossible instead of retrying.' }],
    rationale: 'Three of five failures retried add-to-cart after an out-of-stock alert; a rule and a clearer tool description should let Jev stop early.',
    eval: { train: m(0.7, 0.6, 3500, 0.2, 0.3), heldout: m(0.75, 0.83, 3200, 0.18, 0), before: m(0.58, 0.5, 4100, 0.31, 0), after: m(0.75, 0.83, 3200, 0.18, 0) }, verdict: 'kept', createdAt: '2026-10-10T11:00:00.000Z' };
  const v3 = { ...v2, version: 3, parent: 2, active: false, patch: [{ op: 'replace', path: '/jev/confidenceThreshold', value: 0.9 }], rationale: 'Raise the Jev threshold so more borderline steps go to the LLM.',
    eval: { heldout: m(0.72, 0.83, 5900, 0.44, 0), before: m(0.75, 0.83, 3200, 0.18, 0), after: m(0.72, 0.83, 5900, 0.44, 0) }, verdict: 'rolled_back', createdAt: '2026-10-10T12:00:00.000Z' };
  await deps.db.col('harness_configs').insertMany([v1, v2, v3]);
  await deps.db.col('runs').insertMany([
    { runId: 'r1', siteId: SITE, split: 'heldout', configVersion: 1, noRecipes: true, startedAt: '2026-10-10T10:05:00.000Z', finishedAt: '2026-10-10T10:12:00.000Z', metrics: v1.eval.heldout, results: new Array(12).fill({}) },
    { runId: 'r2', siteId: SITE, split: 'heldout', configVersion: 2, noRecipes: true, startedAt: '2026-10-10T11:05:00.000Z', finishedAt: '2026-10-10T11:12:00.000Z', metrics: v2.eval.heldout, results: new Array(12).fill({}) },
    { runId: 'r3', siteId: SITE, split: 'heldout', configVersion: 3, noRecipes: true, startedAt: '2026-10-10T12:05:00.000Z', finishedAt: '2026-10-10T12:12:00.000Z', metrics: v3.eval.heldout, results: new Array(12).fill({}) },
  ]);
  const visits = [
    visit(1, { goal: goals[0].text, outcome: 'success', ms: 2800, tiers: ['T1_jev', 'T1_jev', 'T1_jev'], configVersion: 1 }),
    visit(2, { goal: goals[0].text, outcome: 'success', ms: 1900, tiers: ['T1_recipe', 'T1_recipe', 'T1_jev'], configVersion: 2 }),
    visit(3, { goal: goals[1].text, outcome: 'impossible', failureReason: 'unavailable', ms: 2100, tiers: ['T1_jev', 'T1_jev'], configVersion: 2 }),
    visit(4, { goal: goals[1].text, outcome: 'failed', failureReason: 'unavailable', ms: 9200, tiers: ['T1_jev', 'T2_llm', 'T2_llm', 'T1_jev'], configVersion: 1 }),
    visit(5, { goal: goals[2].text, outcome: 'failed', failureReason: 'validation_error', ms: 6400, tiers: ['T1_jev', 'T1_jev', 'T2_llm', 'T1_jev', 'T1_jev'], configVersion: 2 }),
    visit(6, { goal: goals[3].text, outcome: 'success', ms: 1500, tiers: ['T0_tool', 'T1_jev'], configVersion: 2 }),
    visit(7, { goal: goals[4].text, outcome: 'impossible', failureReason: 'not_found', ms: 1200, tiers: ['T1_jev'], configVersion: 2 }),
    visit(8, { goal: 'Tell me a joke about hiking boots.', outcome: 'failed', failureReason: 'other', ms: 3300, tiers: ['T1_jev', 'T2_llm'], configVersion: 2 }),
  ];
  await deps.db.col('visits').insertMany(visits);
  await deps.db.col('visits').insertOne({ ...visit(99, { goal: 'x', outcome: 'success', ms: 1, tiers: ['T1_jev'] }), siteId: 'other-site' });
  return { goals, visits };
}

function listen(server) { return new Promise((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`))); }

test('GET /api/analytics computes observed metrics from the DB and flags the cost estimate', async (t) => {
  const deps = makeFakeDeps();
  await seed(deps);
  const server = createServer({ deps, siteDefaults: { siteId: SITE } });
  const base = await listen(server);
  t.after(() => server.close());

  const res = await fetch(`${base}/api/analytics?site=${SITE}`);
  assert.equal(res.status, 200);
  const a = await res.json();
  assert.equal(a.siteId, SITE);

  // (a) headline — the other-site visit must not leak in
  assert.equal(a.visits.n, 8);
  assert.deepEqual(a.visits.outcomes, { success: 3, failed: 3, impossible: 2 });
  assert.equal(a.headline.successRate.value, 0.5); // 3 / (3 + 3)
  assert.equal(a.headline.successRate.n, 6);
  assert.equal(a.headline.successRate.kind, 'observed');
  assert.equal(a.headline.impossibleShare.value, 0.25); // 2 / 8
  const sorted = [1200, 1500, 1900, 2100, 2800, 3300, 6400, 9200];
  assert.equal(a.headline.medianMs.value, (2100 + 2800) / 2);
  assert.equal(a.headline.medianMs.n, 8);
  assert.equal(a.headline.p90Ms.value, sorted[6] + (sorted[7] - sorted[6]) * 0.3);

  // (b) intents grouped by goal kind via text match
  const kinds = Object.fromEntries(a.intents.byKind.map((k) => [k.kind, k]));
  assert.deepEqual(Object.keys(kinds).sort(), ['add_to_cart', 'find', 'impossible', 'other', 'place_order']);
  assert.equal(kinds.add_to_cart.n, 4);
  assert.equal(kinds.add_to_cart.success, 2); assert.equal(kinds.add_to_cart.failed, 1); assert.equal(kinds.add_to_cart.impossible, 1);
  assert.equal(kinds.add_to_cart.successRate, +(2 / 3).toFixed(4));
  assert.equal(kinds.other.n, 1); assert.equal(kinds.other.successRate, 0);
  assert.equal(kinds.impossible.successRate, null, 'no decided visits -> no rate, never a fake 0');
  assert.equal(a.intents.byKind[0].kind, 'add_to_cart', 'sorted by count');
  assert.equal(a.intents.recent.length, 8);
  assert.equal(a.intents.recent[0].goal, 'Tell me a joke about hiking boots.', 'newest first');
  assert.equal(a.intents.recent[0].kind, 'other');

  // (c) failures
  assert.deepEqual(a.failures.byReason, { unavailable: 2, validation_error: 1, not_found: 1, other: 1 });
  assert.equal(a.failures.byKind.add_to_cart.unavailable, 2);
  assert.equal(a.failures.n, 5);

  // (d) unmet demand grouped by goal text
  const unmet = Object.fromEntries(a.unmet.map((u) => [u.goal, u]));
  assert.equal(a.unmet.length, 2);
  assert.equal(a.unmet[0].goal, 'Put a Trail Runner, size 10, in the cart.');
  assert.equal(unmet['Put a Trail Runner, size 10, in the cart.'].n, 2);
  assert.equal(unmet['Put a Trail Runner, size 10, in the cart.'].impossible, 1);
  assert.equal(unmet['Put a Trail Runner, size 10, in the cart.'].unavailable, 2);
  assert.equal(unmet['I want vegan hiking boots.'].not_found, 1);

  // (e) latency histogram covers every visit
  assert.equal(a.latency.n, 8);
  assert.equal(a.latency.bins.reduce((s, b) => s + b.n, 0), 8);
  assert.equal(a.latency.maxMs, 9200);

  // (f) tiers
  assert.deepEqual(a.tiers.total, { T1_jev: 15, T1_recipe: 2, T2_llm: 4, T0_tool: 1 });
  assert.equal(a.tiers.steps, 22);
  assert.equal(a.tiers.shares.T2_llm, +(4 / 22).toFixed(4));
  assert.equal(a.tiers.shares.T1_jev, +(15 / 22).toFixed(4));
  const v1t = a.tiers.byVersion.find((v) => v.configVersion === 1), v2t = a.tiers.byVersion.find((v) => v.configVersion === 2);
  assert.equal(v1t.n, 2); assert.equal(v1t.steps, 7); assert.equal(v1t.tierCounts.T2_llm, 2);
  assert.equal(v2t.n, 6); assert.equal(v2t.steps, 15); assert.equal(v2t.shares.T1_recipe, +(2 / 15).toFixed(4));

  // (g) cost is an estimate with the formula and assumptions on it
  assert.equal(a.cost.kind, 'estimate');
  assert.equal(a.cost.jevSteps, 19); // T1_jev + T2_llm
  assert.equal(a.cost.llmSteps, 4);
  const model = process.env.NEON_MODEL || 'gpt-5-4-mini';
  const [pi, po] = PRICES[model] || [1, 5];
  assert.equal(a.cost.model, model);
  assert.equal(a.cost.jevUsd, +((19 * 1500 * 0.042) / 1e6).toFixed(6));
  assert.equal(a.cost.llmUsd, +((4 * (2000 * pi + 150 * po)) / 1e6).toFixed(6));
  assert.equal(a.cost.totalUsd, +(a.cost.jevUsd + a.cost.llmUsd).toFixed(6));
  assert.match(a.cost.formula, /1,500 tokens/);
  assert.equal(a.cost.assumptions.jevUsdPerMTokens, 0.042);

  // (h) versions + runs
  assert.deepEqual(a.versions.map((v) => v.version), [1, 2, 3]);
  assert.equal(a.versions[1].active, true);
  assert.equal(a.versions[1].visits, 6);
  assert.equal(a.versions[2].verdict, 'rolled_back');
  assert.equal(a.versions[0].heldout.successPossible, 0.58);
  assert.equal(a.runs.length, 3);
  assert.equal(a.runs[0].configVersion, 1);
});

test('GET /api/analytics on an empty site reports n=0 and null rates, not zeros', async (t) => {
  const deps = makeFakeDeps();
  const server = createServer({ deps, siteDefaults: { siteId: SITE } });
  const base = await listen(server);
  t.after(() => server.close());
  const a = await (await fetch(`${base}/api/analytics?site=nobody`)).json();
  assert.equal(a.visits.n, 0);
  assert.equal(a.headline.successRate.value, null);
  assert.equal(a.headline.medianMs.value, null);
  assert.deepEqual(a.intents.byKind, []);
  assert.deepEqual(a.unmet, []);
  assert.equal(a.cost.perVisitUsd, null);
  assert.equal(a.cost.totalUsd, 0);
});

test('/dashboard/ and /evolution/ serve self-contained HTML', async (t) => {
  const deps = makeFakeDeps();
  const server = createServer({ deps, siteDefaults: { siteId: SITE } });
  const base = await listen(server);
  t.after(() => server.close());
  for (const p of ['/dashboard/', '/dashboard', '/dashboard/anything', '/evolution/', '/evolution']) {
    const r = await fetch(base + p);
    assert.equal(r.status, 200, p);
    assert.match(r.headers.get('content-type'), /text\/html/, p);
    const html = await r.text();
    assert.match(html, /^<!doctype html>/i, p);
    assert.ok(!/<script[^>]+src=|<link[^>]+href=["']https?:/i.test(html), `${p} must not load external assets`);
    assert.match(html, /prefers-color-scheme:\s*dark/, `${p} supports dark mode`);
  }
  const d = await (await fetch(base + '/dashboard/')).text();
  assert.match(d, /\/api\/analytics/);
  assert.match(d, /ESTIMATE/);
  const e = await (await fetch(base + '/evolution/')).text();
  assert.match(e, /\/api\/evolution/);
});

module.exports = { seed, SITE };
