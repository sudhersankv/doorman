'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { composeGoals, splitFor, toVerifySpec, paraphrase, expand } = require('../../src/sim/goals');
const { makeFakeDeps } = require('../../src/lib');

test('offline goals: counts, answer key, split, uniqueness', async () => {
  const goals = await composeGoals({ offline: true });
  assert.ok(goals.length >= 55 && goals.length <= 65, `got ${goals.length}`);
  const by = (f) => goals.filter(f).length;
  for (const flaw of ['A', 'B', 'C', 'D']) assert.equal(by((g) => g.flaw === flaw), 6, `flaw ${flaw}`);
  assert.equal(by((g) => g.flaw === null && g.possible), 30);
  assert.equal(by((g) => g.flaw === null && !g.possible && g.kind === 'impossible'), 6);
  // answer key fields
  for (const g of goals) {
    assert.match(g.id, /^g\d{3}_/);
    assert.ok(['add_to_cart', 'place_order', 'view_order', 'find', 'impossible'].includes(g.kind), g.kind);
    assert.equal(typeof g.possible, 'boolean');
    assert.ok(['train', 'heldout'].includes(g.split));
    assert.ok(typeof g.text === 'string' && g.text.length > 3);
    assert.equal(g.split, splitFor(g.id));
    if (g.kind === 'add_to_cart') assert.ok(g.params.productId && 'size' in g.params);
    if (g.kind === 'place_order') assert.match(g.params.zip, /^\d{5}$/);
    if (g.kind === 'view_order') assert.equal(g.params.orderId, '1042');
    if (g.kind === 'impossible') assert.ok(g.params.topic);
  }
  // planted flaws map to the right keys
  for (const g of goals.filter((x) => x.flaw === 'A')) { assert.equal(g.params.productId, 'trail-runner'); assert.equal(g.params.size, 10); assert.equal(g.possible, false); }
  for (const g of goals.filter((x) => x.flaw === 'B')) { assert.ok(g.params.zip.startsWith('9')); assert.equal(g.possible, false); }
  for (const g of goals.filter((x) => x.flaw === 'C')) { assert.equal(g.kind, 'view_order'); assert.equal(g.possible, true); }
  for (const g of goals.filter((x) => x.flaw === 'D')) { assert.equal(g.kind, 'impossible'); assert.equal(g.possible, false); }
  for (const g of goals.filter((x) => x.kind === 'place_order' && x.possible)) assert.ok(!g.params.zip.startsWith('9'));
  // no duplicates
  assert.equal(new Set(goals.map((g) => g.id)).size, goals.length, 'ids unique');
  assert.equal(new Set(goals.map((g) => g.text)).size, goals.length, 'texts unique');
  // split proportions ~2:1
  const heldout = by((g) => g.split === 'heldout') / goals.length;
  assert.ok(heldout > 0.2 && heldout < 0.5, `heldout share ${heldout}`);
  // deterministic
  const again = await composeGoals({ offline: true });
  assert.deepEqual(again, goals);
});

test('split is a pure function of id', () => {
  assert.equal(splitFor('abc'), splitFor('abc'));
  const kinds = new Set(['x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'x7', 'x8', 'x9'].map(splitFor));
  assert.ok(kinds.has('train') && kinds.has('heldout'));
});

test('toVerifySpec maps params onto verify.js spec', () => {
  assert.deepEqual(toVerifySpec({ kind: 'add_to_cart', params: { productId: 'road-racer', size: 9 }, flaw: null }), { kind: 'add_to_cart', flaw: undefined, productId: 'road-racer', size: 9 });
  assert.deepEqual(toVerifySpec({ kind: 'view_order', params: { orderId: '1042' }, flaw: 'C' }), { kind: 'view_order', flaw: 'C', orderId: '1042' });
});

test('LLM paraphrase pass only changes text; falls back when the LLM is unusable', async () => {
  const goals = expand();
  const deps = makeFakeDeps({ llmHandlers: { goals: (messages) => {
    const list = JSON.parse(messages[1].content.split('Requests:\n')[1]);
    return { phrasings: Object.fromEntries(list.map((g) => [g.id, `LLM: ${g.statement}`])) };
  } } });
  const texts = await paraphrase(goals, deps);
  assert.ok(Object.values(texts).every((t) => t.startsWith('LLM: ')));
  const online = await composeGoals({ deps });
  const offline = await composeGoals({ offline: true });
  online.forEach((g, i) => { const { text: a, ...ka } = g; const { text: b, ...kb } = offline[i]; assert.deepEqual(ka, kb); });
  // broken LLM -> offline phrasing
  const bad = makeFakeDeps({ llmHandlers: { goals: () => 'not json at all' } });
  const fallback = await composeGoals({ deps: bad });
  assert.deepEqual(fallback, offline);
});
