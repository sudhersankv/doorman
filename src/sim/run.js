'use strict';
/**
 * Benchmark runner: runs a goal split against a live server with one Chromium, writes a `runs` doc, returns metrics.
 * CLI: node src/sim/run.js --split train|heldout|all --config <version> --base http://localhost:3000 [--concurrency 4] [--limit N]
 * Editor hook: makeRunGoals({ deps, baseUrl }) -> (split, configVersion) => Promise<metrics>
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { runGoal } = require('./agent');
const { summarize } = require('./metrics');

const SITE_ID = 'trailhead';
const GOALS_FILE = path.join(__dirname, '..', '..', 'data', 'goals.json');

/** Load goals from data/goals.json, else the `goals` collection, else compose offline. */
async function loadGoals({ deps, file = GOALS_FILE } = {}) {
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  if (deps?.db) { const rows = await deps.db.col('goals').find({ siteId: SITE_ID }).toArray(); if (rows.length) return rows; }
  return require('./goals').composeGoals({ offline: true });
}

/** Run `fn` over items with at most `limit` in flight; preserves order. */
async function pool(items, limit, fn) {
  const out = new Array(items.length); let next = 0;
  const worker = async () => { for (;;) { const i = next++; if (i >= items.length) return; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

/**
 * Run one split and persist the run.
 * @param {{ split:'train'|'heldout'|'all', configVersion:number, deps:object, baseUrl:string, concurrency?:number, goals?:Array, limit?:number, browser?:object, maxSteps?:number }} args
 * @returns {Promise<object>} metrics (see metrics.js) plus runId
 */
async function runSplit({ split = 'heldout', configVersion = null, deps, baseUrl, concurrency = 4, goals, limit, browser, maxSteps, onResult } = {}) {
  if (!baseUrl) throw new Error('runSplit: baseUrl required');
  const log = deps?.log || (() => {});
  let list = goals || (await loadGoals({ deps }));
  if (split !== 'all') list = list.filter((g) => g.split === split);
  if (limit) list = list.slice(0, limit);
  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const own = !browser;
  if (own) browser = await require('playwright').chromium.launch();
  let results;
  try {
    results = await pool(list, concurrency, async (goal, i) => {
      const r = await runGoal({ goal, baseUrl, browser, deps, maxSteps });
      log('goal', { i: i + 1, of: list.length, id: goal.id, success: r.success, reason: r.reason, ms: r.ms, steps: r.steps });
      if (onResult) onResult(r, i);
      return r;
    });
  } finally { if (own) await browser.close().catch(() => {}); }
  const metrics = summarize(results);
  const doc = { runId, siteId: SITE_ID, split, configVersion, startedAt, finishedAt: new Date().toISOString(), baseUrl, metrics, results };
  if (deps?.db) await deps.db.col('runs').insertOne(doc);
  return { ...metrics, runId, configVersion, split };
}

/**
 * Editor hook (CONTRACTS.md §9): returns `runGoals(split, configVersion)` bound to deps + baseUrl.
 * @param {{ deps:object, baseUrl:string, concurrency?:number, limit?:number }} args
 */
function makeRunGoals({ deps, baseUrl, concurrency = 4, limit } = {}) {
  return (split, configVersion) => runSplit({ split, configVersion, deps, baseUrl, concurrency, limit });
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (a.startsWith('--')) { const k = a.slice(2); const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true'; out[k] = v; } }
  return out;
}

module.exports = { runSplit, makeRunGoals, loadGoals, pool, SITE_ID };

if (require.main === module) {
  (async () => {
    require('../lib/env');
    const a = parseArgs(process.argv.slice(2));
    const base = a.base || process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
    let deps;
    try { deps = await require('../lib').makeDeps(process.env); } catch (e) { console.error(`no real deps (${e.message}); using in-memory fake db — run will not be persisted`); deps = require('../lib').makeFakeDeps(); }
    deps.log = (ev, d) => { if (ev === 'goal') console.error(`[${d.i}/${d.of}] ${d.success ? 'ok  ' : 'FAIL'} ${d.id} ${d.reason || ''} ${d.ms}ms ${d.steps} steps`); };
    const m = await runSplit({ split: a.split || 'heldout', configVersion: a.config != null ? Number(a.config) : null, deps, baseUrl: base, concurrency: Number(a.concurrency) || 4, limit: a.limit ? Number(a.limit) : undefined });
    console.log(JSON.stringify(m, null, 1));
    if (deps.db?.close) await deps.db.close();
  })().catch((e) => { console.error(e); process.exit(1); });
}
