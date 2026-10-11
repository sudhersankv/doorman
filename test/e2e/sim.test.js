'use strict';
// End-to-end: real server (fake deps) + real public/doorman.js in Chromium + a scripted engine that walks a product page.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { createServer } = require('../../server');
const { makeFakeDeps } = require('../../src/lib');
const { runGoal } = require('../../src/sim/agent');
const { runSplit } = require('../../src/sim/run');

const HAS_DOORMAN = fs.existsSync(path.join(__dirname, '..', '..', 'public', 'doorman.js'));

/** Scripted engine: listing -> open product, product -> pick size -> add -> done. Reports impossible for anything else. */
function scriptedEngine() {
  const by = (page, re) => (page.actions || []).find((a) => re.test(a.key) || re.test(a.name || ''));
  const step = (o) => ({ action: null, params: {}, tier: 'T1_jev', confidence: 0.9, done: false, impossible: false, needsConfirmation: false, reason: 'scripted', ...o });
  return {
    async decide({ goal, page, history }) {
      const m = /(\S+) size (\S+)/.exec(goal) || [];
      const productId = m[1], size = m[2];
      if ((page.messages || []).some((x) => /added/i.test(x.text))) return step({ done: true, reason: 'added' });
      if ((page.messages || []).some((x) => x.role === 'alert' && /out of stock/i.test(x.text))) return step({ impossible: true, reason: 'oos' });
      const view = productId && by(page, new RegExp(`^view_${productId.replace(/-/g, '_')}$`));
      if (page.url.includes('#/product/')) {
        const sizeSel = by(page, /^size$/);
        const chosen = (page.fields || []).find((f) => f.key === 'size')?.value;
        if (sizeSel && !chosen && size) return step({ action: 'size', params: { value: String(size) }, tier: 'T1_recipe' });
        const add = by(page, /add/i);
        if (add) return step({ action: add.key, tier: 'T2_llm' });
      }
      if (view) return step({ action: view.key });
      return step({ impossible: true, reason: 'cannot find it' });
    },
    async verifyOutcome({ finalPage }) { const ok = (finalPage?.messages || []).some((x) => /added/i.test(x.text)); return { satisfied: ok ? 1 : 0, failureReason: ok ? null : 'other' }; },
  };
}

let server, base, browser, deps;
before(async () => {
  deps = makeFakeDeps();
  server = createServer({ deps, engine: scriptedEngine() });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
});
after(async () => { if (browser) await browser.close(); if (server) server.close(); });

test('agent.runGoal: add_to_cart succeeds through doorman.js + server + verifier', { skip: !HAS_DOORMAN && 'public/doorman.js not present yet' }, async () => {
  const goal = { id: 'e2e_add', kind: 'add_to_cart', params: { productId: 'road-racer', size: 9 }, possible: true, flaw: null, split: 'heldout', text: 'road-racer size 9 add to cart' };
  const r = await runGoal({ goal, baseUrl: base, browser, deps, maxSteps: 8 });
  assert.equal(r.success, true, JSON.stringify(r));
  assert.equal(r.failureKind, null); assert.equal(r.impossibleReported, false);
  assert.ok(r.steps >= 3, `steps ${r.steps}`); assert.ok(r.ms > 0); assert.ok(r.visitId);
  assert.equal(r.tierCounts.T1_recipe, 1); assert.equal(r.tierCounts.T2_llm, 1);
  assert.equal(deps.db.store.visits.length, 1); assert.equal(deps.db.store.visits[0].outcome, 'success');
  assert.equal(deps.db.store.recipes.length, 1);
});

test('agent.runGoal: flaw A (out of stock) is reported impossible and counted as handled', { skip: !HAS_DOORMAN && 'public/doorman.js not present yet' }, async () => {
  const goal = { id: 'e2e_oos', kind: 'add_to_cart', params: { productId: 'trail-runner', size: 10 }, possible: false, flaw: 'A', split: 'heldout', text: 'trail-runner size 10 add to cart' };
  const r = await runGoal({ goal, baseUrl: base, browser, deps, maxSteps: 8 });
  assert.equal(r.impossibleReported, true, JSON.stringify(r));
  assert.equal(r.success, true); assert.equal(r.failureKind, 'impossible'); assert.equal(r.reason, 'OUT_OF_STOCK');
});

test('run.runSplit writes a runs doc and returns metrics', { skip: !HAS_DOORMAN && 'public/doorman.js not present yet' }, async () => {
  const goals = [
    { id: 'a1', kind: 'add_to_cart', params: { productId: 'road-racer', size: 9 }, possible: true, flaw: null, split: 'train', text: 'road-racer size 9' },
    { id: 'a2', kind: 'add_to_cart', params: { productId: 'trail-runner', size: 10 }, possible: false, flaw: 'A', split: 'train', text: 'trail-runner size 10' },
    { id: 'a3', kind: 'find', params: { productId: 'bottle' }, possible: true, flaw: null, split: 'heldout', text: 'find bottle' },
  ];
  const m = await runSplit({ split: 'train', configVersion: 1, deps, baseUrl: base, goals, browser, concurrency: 2 });
  assert.equal(m.n, 2); assert.equal(m.successPossible, 1); assert.equal(m.impossibleHandled, 1); assert.ok(m.runId);
  assert.equal(m.byFlaw.A.handled, 1);
  const run = deps.db.store.runs.find((x) => x.runId === m.runId);
  assert.ok(run); assert.equal(run.split, 'train'); assert.equal(run.results.length, 2); assert.equal(run.siteId, 'trailhead');
});
