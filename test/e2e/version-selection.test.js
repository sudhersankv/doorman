'use strict';
// Regression: candidate benchmarks must execute the candidate configuration, not the active one.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../../server');
const { makeFakeDeps } = require('../../src/lib');
const cfgMod = require('../../src/harness/config');
const { runSplit } = require('../../src/sim/run');

function withServer(deps, extra = {}) {
  const server = createServer({ deps, siteDefaults: { configCacheMs: 0 }, ...extra });
  return new Promise((resolve) => server.listen(0, () => resolve({ server, base: `http://localhost:${server.address().port}` })));
}
const listingPage = () => ({ siteId: 'trailhead', url: 'x', templateHash: 'h', messages: [], fields: [], items: [],
  actions: [{ key: 'alpha', kind: 'click', name: 'Alpha', selector: '#a' }, { key: 'beta', kind: 'click', name: 'Beta', selector: '#b' }] });

test('/api/decide with configVersion executes that stored version (v2 hides an action v1 exposes)', async () => {
  const deps = makeFakeDeps();
  const { server, base } = await withServer(deps);
  try {
    const v1 = await cfgMod.loadActive('trailhead', deps, { actionKeys: ['alpha', 'beta'] });
    const v2 = cfgMod.applyPatch(v1, [{ op: 'add', path: '/tools/alpha/exposed', value: false }]);
    await cfgMod.saveVersion(v2, deps); // stored, NOT active — exactly how the editor benchmarks a candidate
    const decide = (body) => fetch(`${base}/api/decide`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
    const a = await decide({ siteId: 'trailhead', goal: 'alpha please', page: listingPage(), history: [] });
    const b = await decide({ siteId: 'trailhead', goal: 'alpha please', page: listingPage(), history: [], configVersion: 2 });
    assert.equal(a.trace.configVersion, 1);
    assert.equal(a.step.action, 'alpha', 'active v1 exposes alpha');
    assert.equal(b.trace.configVersion, 2, 'candidate version was executed');
    assert.notEqual(b.step.action, 'alpha', 'v2 hides alpha, so the same goal must decide differently');
    const missing = await fetch(`${base}/api/decide`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ siteId: 'trailhead', goal: 'g', page: listingPage(), history: [], configVersion: 99 }) });
    assert.equal(missing.status, 404, 'unknown version is an error, never a silent fallback to active');
  } finally { server.close(); }
});

test('runSplit passes configVersion + noRecipes through doorman.js to the server; visits are logged on that version', async () => {
  const deps = makeFakeDeps();
  const seen = [];
  const engine = {
    async decide({ config, deps: d }) { seen.push({ version: config.version, recipes: !!(d && d.recipes) }); return { action: null, done: true, tier: 'T1_jev', confidence: 0.9 }; },
    async verifyOutcome() { return { satisfied: 1, failureReason: null }; },
  };
  const { server, base } = await withServer(deps, { engine });
  try {
    const v1 = await cfgMod.loadActive('trailhead', deps);
    await cfgMod.saveVersion(cfgMod.applyPatch(v1, [{ op: 'add', path: '/rules/-', value: 'r' }]), deps); // v2, inactive
    const goal = { id: 'g1', kind: 'find', params: { productId: 'road-racer' }, possible: true, flaw: null, split: 'heldout', text: 'find the road racer' };
    await runSplit({ split: 'heldout', configVersion: 2, deps, baseUrl: base, concurrency: 1, goals: [goal], noRecipes: true });
    assert.ok(seen.length >= 1);
    assert.ok(seen.every((s) => s.version === 2), `every decide ran v2, got ${JSON.stringify(seen)}`);
    assert.ok(seen.every((s) => s.recipes === false), 'noRecipes removed recipe memory from the evaluation');
    const visits = deps.db.store.visits;
    assert.equal(visits.length, 1);
    assert.equal(visits[0].configVersion, 2, 'the visit is attributed to the candidate version');
    const run = deps.db.store.runs[0];
    assert.equal(run.configVersion, 2); assert.equal(run.noRecipes, true);
  } finally { server.close(); }
});
