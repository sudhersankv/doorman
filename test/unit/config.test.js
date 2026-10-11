'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeFakeDeps } = require('../../src/lib');
const cfg = require('../../src/harness/config');

test('defaultConfig: contract defaults + confirm seeded from action keys', () => {
  const c = cfg.defaultConfig('site1', { actionKeys: ['search', 'place_order', 'pay_now', 'view_thing', 'confirm_booking'] });
  assert.equal(c.siteId, 'site1');
  assert.equal(c.version, 1); assert.equal(c.parent, null); assert.equal(c.active, true); assert.equal(c.createdBy, 'seed');
  assert.deepEqual(c.tools, {});
  assert.deepEqual(c.context, { includeMessages: true, includeItems: true, maxItems: 12, historySteps: 4, recipesTopK: 3, recipeMinScore: 0.88 });
  assert.equal(c.jev.confidenceThreshold, 0.70);
  assert.equal(c.guardrails.maxSteps, 8); assert.equal(c.guardrails.impossibleThreshold, 0.80);
  assert.deepEqual(c.guardrails.confirm, ['place_order', 'pay_now', 'confirm_booking']);
  assert.deepEqual(c.rules, []);
  assert.equal(c.eval, null); assert.equal(c.patch, null); assert.equal(c.verdict, null);
  assert.ok(typeof c.createdAt === 'string');
});

const base = () => { const c = cfg.defaultConfig('s'); c.rules = ['existing rule']; return c; };

test('validatePatch: accepts a valid 3-op patch', () => {
  const r = cfg.validatePatch([
    { op: 'replace', path: '/jev/confidenceThreshold', value: 0.8 },
    { op: 'add', path: '/rules/-', value: 'Prefer actions on the current page.' },
    { op: 'add', path: '/tools/search/description', value: 'Finds things by keyword' },
  ], base());
  assert.deepEqual(r, { ok: true, errors: [] });
});

test('validatePatch: rejections', () => {
  const reject = (patch, label) => { const r = cfg.validatePatch(patch, base()); assert.equal(r.ok, false, label); assert.ok(r.errors.length > 0, label); };
  reject([1, 2, 3, 4].map((i) => ({ op: 'add', path: '/rules/-', value: `r${i}` })), '4 ops');
  reject([{ op: 'replace', path: '/jev/model', value: 'x' }], 'unknown path');
  reject([{ op: 'replace', path: '/nope', value: 1 }], 'unknown top-level');
  reject([{ op: 'remove', path: '/guardrails/confirm/0' }], 'remove from confirm');
  reject([{ op: 'replace', path: '/guardrails/confirm', value: [] }], 'replace confirm');
  reject([{ op: 'replace', path: '/guardrails/confirm/-', value: 'pay' }], 'replace on confirm/-');
  reject([{ op: 'replace', path: '/jev/confidenceThreshold', value: 0.3 }], 'threshold 0.3');
  reject([{ op: 'replace', path: '/jev/confidenceThreshold', value: 0.99 }], 'threshold 0.99');
  reject([{ op: 'replace', path: '/guardrails/maxSteps', value: 20 }], 'maxSteps 20');
  reject([{ op: 'add', path: '/rules/-', value: 42 }], 'non-string rule');
  reject([{ op: 'replace', path: '/rules/0', value: 'x'.repeat(201) }], 'rule too long');
  reject([{ op: 'replace', path: '/rules/5', value: 'x' }], 'rule index out of range');
  reject([{ op: 'replace', path: '/context/maxItems', value: 31 }], 'maxItems 31');
  reject([{ op: 'replace', path: '/context/historySteps', value: 0 }], 'historySteps 0');
  reject([{ op: 'replace', path: '/context/recipesTopK', value: 6 }], 'recipesTopK 6');
  reject([{ op: 'replace', path: '/jev/nextInstructions', value: 'x'.repeat(601) }], 'nextInstructions too long');
  reject([{ op: 'replace', path: '/tools/search/exposed', value: 'yes' }], 'exposed non-boolean');
  reject([{ op: 'replace', path: '/tools/search/color', value: 'red' }], 'unknown tool field');
  reject([], 'empty patch');
  reject('nope', 'non-array');
});

test('validatePatch: edge-allowed ops', () => {
  const ok = (patch) => assert.deepEqual(cfg.validatePatch(patch, base()), { ok: true, errors: [] });
  ok([{ op: 'add', path: '/guardrails/confirm/-', value: 'place_order' }]);
  ok([{ op: 'remove', path: '/rules/0' }]);
  ok([{ op: 'replace', path: '/rules/0', value: 'new text' }]);
  ok([{ op: 'replace', path: '/guardrails/impossibleThreshold', value: 0.6 }]);
  ok([{ op: 'replace', path: '/jev/confidenceThreshold', value: 0.95 }]);
  ok([{ op: 'replace', path: '/tools/search/exposed', value: false }]);
  ok([{ op: 'replace', path: '/context/includeItems', value: false }]);
});

test('applyPatch: increments version/parent, sets editor, keeps original untouched', () => {
  const original = base();
  const snapshot = JSON.stringify(original);
  const patch = [
    { op: 'replace', path: '/jev/confidenceThreshold', value: 0.8 },
    { op: 'add', path: '/rules/-', value: 'r2' },
    { op: 'add', path: '/tools/search/description', value: 'find' },
  ];
  const next = cfg.applyPatch(original, patch);
  assert.equal(JSON.stringify(original), snapshot);
  assert.equal(next.version, 2); assert.equal(next.parent, 1); assert.equal(next.createdBy, 'editor');
  assert.equal(next.active, false);
  assert.deepEqual(next.patch, patch); assert.equal(next.eval, null); assert.equal(next.verdict, null);
  assert.equal(next.jev.confidenceThreshold, 0.8);
  assert.deepEqual(next.rules, ['existing rule', 'r2']);
  assert.deepEqual(next.tools.search, { exposed: true, description: 'find' });

  const third = cfg.applyPatch(next, [{ op: 'remove', path: '/rules/0' }, { op: 'add', path: '/guardrails/confirm/-', value: 'pay' }, { op: 'replace', path: '/tools/search/exposed', value: false }]);
  assert.equal(third.version, 3); assert.equal(third.parent, 2);
  assert.deepEqual(third.rules, ['r2']); assert.deepEqual(third.guardrails.confirm, ['pay']);
  assert.equal(third.tools.search.exposed, false);
});

test('store: loadActive seeds once, activate flips flags, setEval, history ordered', async () => {
  const deps = makeFakeDeps();
  const a = await cfg.loadActive('s', deps, { actionKeys: ['submit_form'] });
  const b = await cfg.loadActive('s', deps);
  assert.equal(a._id, b._id); assert.equal(a.version, 1);
  assert.deepEqual(a.guardrails.confirm, ['submit_form']);
  assert.equal(await deps.db.col('harness_configs').countDocuments({ siteId: 's' }), 1);

  const v2 = await cfg.saveVersion(cfg.applyPatch(a, [{ op: 'add', path: '/rules/-', value: 'r' }]), deps);
  const v3 = await cfg.saveVersion(cfg.applyPatch(v2, [{ op: 'add', path: '/rules/-', value: 'r3' }]), deps);
  assert.equal((await cfg.loadActive('s', deps)).version, 1);

  const act = await cfg.activate('s', 3, deps);
  assert.equal(act.active, true);
  assert.equal((await cfg.loadActive('s', deps)).version, 3);
  assert.equal(await deps.db.col('harness_configs').countDocuments({ siteId: 's', active: true }), 1);
  await cfg.activate('s', 1, deps);
  assert.equal((await cfg.loadActive('s', deps)).version, 1);

  const ev = await cfg.setEval('s', 3, { eval: { successPossible: 0.9 }, verdict: 'kept' }, deps);
  assert.deepEqual(ev.eval, { successPossible: 0.9 }); assert.equal(ev.verdict, 'kept');

  const hist = await cfg.history('s', deps);
  assert.deepEqual(hist.map((h) => h.version), [1, 2, 3]);
  assert.equal(hist[2].parent, 2);
  assert.ok(v3.version === 3);
});

test('summarizeForPrompt: compact and bounded', () => {
  const c = base();
  c.tools = { search: { exposed: true, description: 'x'.repeat(300) } };
  c.rules = Array.from({ length: 40 }, (_, i) => `rule ${i} ` + 'y'.repeat(150));
  const s = cfg.summarizeForPrompt(c);
  assert.ok(s.length <= 1500);
  assert.match(s, /config v1/); assert.match(s, /search/); assert.match(s, /confidenceThreshold=0.7/); assert.match(s, /maxSteps=8/);
});
