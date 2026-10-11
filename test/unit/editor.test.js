'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeFakeDeps } = require('../../src/lib');
const cfg = require('../../src/harness/config');
const editor = require('../../src/harness/editor');

const SITE = 'test-site';
const BASE = { successPossible: 0.60, impossibleHandled: 0.80, medianMs: 4000, llmFallbackRate: 0.30, recipeHitRate: 0.10 };
const GOOD_PATCH = [{ op: 'add', path: '/rules/-', value: 'When the page shows an alert, read it before choosing the next action.' }];
const BAD_PATCH = [{ op: 'remove', path: '/guardrails/confirm/0' }];

/** runGoals that returns scripted metrics per version; records calls. */
function scriptedRunGoals(byVersion) {
  const calls = [];
  const fn = async (split, version) => {
    calls.push([split, version]);
    const m = byVersion[version] || byVersion.default || BASE;
    return { ...m };
  };
  fn.calls = calls;
  return fn;
}

async function seedWithVisits(deps) {
  const c = await cfg.loadActive(SITE, deps);
  await deps.db.col('visits').insertMany([
    { siteId: SITE, configVersion: 1, goal: 'do the thing', outcome: 'failed', failureReason: 'not_found', ms: 9000, tierCounts: { T1_jev: 3, T2_llm: 2 },
      history: [{ action: 'open_list', params: {}, tier: 'T1_jev', outcome: 'ok', messagesAfter: [{ role: 'alert', text: 'Nothing matched' }] }] },
    { siteId: SITE, configVersion: 1, goal: 'another thing', outcome: 'success', ms: 2000, tierCounts: { T1_recipe: 2 }, history: [] },
  ]);
  return c;
}

test('proposePatch: valid patch passes through; prompt contains allowed paths and config summary', async () => {
  let seen;
  const deps = makeFakeDeps({ llmHandlers: { editor: (messages) => { seen = messages; return { rationale: 'add a rule', patch: GOOD_PATCH }; } } });
  const config = await cfg.loadActive(SITE, deps);
  const r = await editor.proposePatch({ config, worstVisits: [], metrics: BASE, deps });
  assert.deepEqual(r.patch, GOOD_PATCH);
  assert.equal(r.rationale, 'add a rule');
  const text = seen.map((m) => m.content).join('\n');
  assert.match(text, /\/guardrails\/confirm\/- \(add only; remove never allowed\)/);
  assert.match(text, /config v1/);
  assert.match(text, /successPossible=0\.6/);
  assert.equal(deps.llm.calls(), 1);
});

test('(a) evolveOnce: improving patch is kept, active version advances, both versions evaluated', async () => {
  const deps = makeFakeDeps({ llmHandlers: { editor: () => ({ rationale: 'add a rule', patch: GOOD_PATCH }) } });
  await seedWithVisits(deps);
  const runGoals = scriptedRunGoals({ 1: BASE, 2: { ...BASE, successPossible: 0.70 } });
  const r = await editor.evolveOnce({ siteId: SITE, deps, runGoals });
  assert.equal(r.verdict, 'kept');
  assert.equal(r.from, 1); assert.equal(r.to, 2);
  assert.equal(r.before.successPossible, 0.60); assert.equal(r.after.successPossible, 0.70);
  assert.deepEqual(r.patch, GOOD_PATCH);
  // order: heldout baseline on v1, then train on v2, then heldout on v2
  assert.deepEqual(runGoals.calls, [['heldout', 1], ['train', 2], ['heldout', 2]]);
  const active = await cfg.loadActive(SITE, deps);
  assert.equal(active.version, 2);
  assert.equal(active.rules.length, 1);
  const hist = await cfg.history(SITE, deps);
  assert.equal(hist.length, 2);
  assert.equal(hist[0].active, false); assert.equal(hist[0].eval.heldout.successPossible, 0.60);
  assert.equal(hist[1].active, true); assert.equal(hist[1].verdict, 'kept');
  assert.equal(hist[1].eval.heldout.successPossible, 0.70); assert.equal(hist[1].eval.train.successPossible, 0.70);
  assert.equal(hist[1].eval.before.successPossible, 0.60); assert.equal(hist[1].eval.after.successPossible, 0.70);
});

test('(a2) evolveOnce: latency win with flat success is kept', async () => {
  const deps = makeFakeDeps({ llmHandlers: { editor: () => ({ rationale: 'r', patch: GOOD_PATCH }) } });
  await cfg.loadActive(SITE, deps);
  const runGoals = scriptedRunGoals({ 1: BASE, 2: { ...BASE, successPossible: 0.59, medianMs: 3000 } });
  const r = await editor.evolveOnce({ siteId: SITE, deps, runGoals, trainFirst: false });
  assert.equal(r.verdict, 'kept');
  assert.deepEqual(runGoals.calls, [['heldout', 1], ['heldout', 2]]);
});

test('(b) evolveOnce: non-improving patch is rolled back, old version stays active', async () => {
  const deps = makeFakeDeps({ llmHandlers: { editor: () => ({ rationale: 'r', patch: GOOD_PATCH }) } });
  await seedWithVisits(deps);
  const runGoals = scriptedRunGoals({ 1: BASE, 2: { ...BASE, successPossible: 0.61, medianMs: 3900 } });
  const r = await editor.evolveOnce({ siteId: SITE, deps, runGoals });
  assert.equal(r.verdict, 'rolled_back');
  assert.equal(r.to, 2);
  const active = await cfg.loadActive(SITE, deps);
  assert.equal(active.version, 1);
  assert.equal(active.eval.heldout.successPossible, 0.60);
  const hist = await cfg.history(SITE, deps);
  assert.equal(hist.length, 2);
  assert.equal(hist[1].active, false); assert.equal(hist[1].verdict, 'rolled_back');
  assert.equal(hist[1].eval.heldout.successPossible, 0.61);
});

test('(c) proposePatch retries once with validator errors; invalid then valid -> kept', async () => {
  let n = 0; const prompts = [];
  const deps = makeFakeDeps({ llmHandlers: { editor: (messages) => { prompts.push(messages[1].content); n++; return n === 1 ? { rationale: 'bad', patch: BAD_PATCH } : { rationale: 'good', patch: GOOD_PATCH }; } } });
  await cfg.loadActive(SITE, deps);
  const runGoals = scriptedRunGoals({ 1: BASE, 2: { ...BASE, successPossible: 0.9 } });
  const r = await editor.evolveOnce({ siteId: SITE, deps, runGoals });
  assert.equal(r.verdict, 'kept');
  assert.equal(r.rationale, 'good');
  assert.equal(deps.llm.calls(), 2);
  assert.doesNotMatch(prompts[0], /REJECTED/);
  assert.match(prompts[1], /REJECTED/);
  assert.match(prompts[1], /confirm is append-only/);
});

test('(c2) invalid twice -> no_patch, no new version, runGoals only for the baseline', async () => {
  const deps = makeFakeDeps({ llmHandlers: { editor: () => ({ rationale: 'bad', patch: BAD_PATCH }) } });
  await cfg.loadActive(SITE, deps);
  const runGoals = scriptedRunGoals({ default: BASE });
  const r = await editor.evolveOnce({ siteId: SITE, deps, runGoals });
  assert.equal(r.verdict, 'no_patch');
  assert.equal(r.to, null);
  assert.deepEqual(r.patch, []);
  assert.ok(r.errors.length > 0);
  assert.equal(deps.llm.calls(), 2);
  assert.deepEqual(runGoals.calls, [['heldout', 1]]);
  assert.equal((await cfg.history(SITE, deps)).length, 1);
});

test('(c3) non-JSON reply then valid -> kept; too many ops is rejected', async () => {
  let n = 0;
  const deps = makeFakeDeps({ llmHandlers: { editor: () => (++n === 1 ? 'sorry, no' : { rationale: 'ok', patch: GOOD_PATCH }) } });
  const config = await cfg.loadActive(SITE, deps);
  const r = await editor.proposePatch({ config, deps });
  assert.deepEqual(r.patch, GOOD_PATCH);
  const deps2 = makeFakeDeps({ llmHandlers: { editor: () => ({ rationale: 'ok', patch: [GOOD_PATCH[0], GOOD_PATCH[0]] }) } });
  const r2 = await editor.proposePatch({ config, deps: deps2, maxOps: 1 });
  assert.deepEqual(r2.patch, []);
  assert.match(r2.errors.join(' '), /max 1/);
});

test('(d) evolve: 2 generations chain versions; baseline reused from stored eval', async () => {
  let n = 0;
  const deps = makeFakeDeps({ llmHandlers: { editor: () => ({ rationale: `gen${++n}`, patch: [{ op: 'add', path: '/rules/-', value: `rule ${n}` }] }) } });
  await seedWithVisits(deps);
  const runGoals = scriptedRunGoals({ 1: BASE, 2: { ...BASE, successPossible: 0.70 }, 3: { ...BASE, successPossible: 0.80 } });
  const seen = [];
  const results = await editor.evolve({ siteId: SITE, generations: 2, deps, runGoals, onGeneration: (r, i) => seen.push([i, r.verdict]) });
  assert.equal(results.length, 2);
  assert.deepEqual(results.map((r) => [r.from, r.to, r.verdict]), [[1, 2, 'kept'], [2, 3, 'kept']]);
  assert.deepEqual(seen, [[0, 'kept'], [1, 'kept']]);
  // generation 2 reuses v2's stored held-out metrics instead of re-running the baseline
  assert.deepEqual(runGoals.calls, [['heldout', 1], ['train', 2], ['heldout', 2], ['train', 3], ['heldout', 3]]);
  const active = await cfg.loadActive(SITE, deps);
  assert.equal(active.version, 3);
  assert.deepEqual(active.rules, ['rule 1', 'rule 2']);
  assert.equal(active.parent, 2);
  assert.equal(results[1].before.successPossible, 0.70);
});

test('keepRule follows CONTRACTS §9', () => {
  const b = { successPossible: 0.5, medianMs: 1000 };
  assert.equal(editor.keepRule(b, { successPossible: 0.53, medianMs: 2000 }), true);
  assert.equal(editor.keepRule(b, { successPossible: 0.52, medianMs: 2000 }), false);
  assert.equal(editor.keepRule(b, { successPossible: 0.48, medianMs: 899 }), true);
  assert.equal(editor.keepRule(b, { successPossible: 0.48, medianMs: 900 }), false);
  assert.equal(editor.keepRule(b, { successPossible: 0.47, medianMs: 500 }), false);
});

test('visit worst/metrics (visits module or built-in fallback) read the visits collection', async () => {
  const deps = makeFakeDeps();
  await seedWithVisits(deps);
  const worst = await editor.worstVisits({ siteId: SITE, configVersion: 1, deps });
  assert.equal(worst[0].outcome, 'failed');
  const m = await editor.visitMetrics({ siteId: SITE, configVersion: 1, deps });
  assert.equal(m.visits ?? m.n, 2);
  assert.equal(m.successPossible ?? m.successRate, 0.5);
  assert.equal(m.llmFallbackRate, 2 / 7);
});

test('worst traces and metrics reach the editor prompt', async () => {
  let seen;
  const deps = makeFakeDeps({ llmHandlers: { editor: (messages) => { seen = messages[1].content; return { rationale: 'r', patch: GOOD_PATCH }; } } });
  await seedWithVisits(deps);
  await editor.evolveOnce({ siteId: SITE, deps, runGoals: scriptedRunGoals({ default: BASE }), trainFirst: false });
  assert.match(seen, /goal="do the thing" outcome=failed reason=not_found/);
  assert.match(seen, /Nothing matched/);
  assert.match(seen, /llmFallbackRate=0\.286/);
  assert.match(seen, /successPossible=0\.6/);
});
