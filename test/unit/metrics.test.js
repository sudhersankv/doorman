'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { summarize, quantile } = require('../../src/sim/metrics');

const r = (o) => ({ goalId: 'g', success: false, ms: 1000, steps: 2, tierCounts: {}, impossibleReported: false, possible: true, flaw: null, kind: 'add_to_cart', ...o });

test('summarize on empty input gives zeros', () => {
  const m = summarize([]);
  assert.equal(m.n, 0); assert.equal(m.successPossible, 0); assert.equal(m.impossibleHandled, 0);
  assert.equal(m.medianMs, 0); assert.equal(m.p90Ms, 0); assert.equal(m.llmFallbackRate, 0); assert.equal(m.recipeHitRate, 0); assert.equal(m.avgSteps, 0);
  assert.deepEqual(m.byFlaw, {}); assert.deepEqual(m.byKind, {});
});

test('rates, quantiles, tiers and groupings', () => {
  const results = [
    r({ success: true, ms: 100, steps: 2, tierCounts: { T1_recipe: 2 } }),
    r({ success: true, ms: 200, steps: 3, tierCounts: { T1_jev: 2, T2_llm: 1 } }),
    r({ success: false, ms: 300, steps: 4, tierCounts: { T1_jev: 2, T2_llm: 2 } }),
    r({ success: false, ms: 400, steps: 1, tierCounts: { T1_jev: 1 }, kind: 'find' }),
    r({ possible: false, flaw: 'A', impossibleReported: true, success: true, ms: 500, steps: 2, tierCounts: { T1_jev: 2 } }),
    r({ possible: false, flaw: 'A', impossibleReported: false, success: false, ms: 600, steps: 3, tierCounts: { T1_jev: 3 } }),
    r({ possible: false, flaw: 'D', impossibleReported: true, success: true, ms: 700, steps: 1, tierCounts: { T2_llm: 1 }, kind: 'impossible' }),
  ];
  const m = summarize(results);
  assert.equal(m.n, 7);
  assert.equal(m.successPossible, 0.5);           // 2 of 4 possible
  assert.equal(m.impossibleHandled, +(2 / 3).toFixed(4)); // 2 of 3 impossible reported
  assert.equal(m.medianMs, 400);
  assert.equal(m.p90Ms, 640);                      // linear interpolation between 600 and 700
  assert.equal(m.llmFallbackRate, +(4 / 16).toFixed(4)); // 4 llm steps of 16
  assert.equal(m.recipeHitRate, +(1 / 7).toFixed(4));
  assert.equal(m.avgSteps, +(16 / 7).toFixed(2));
  assert.equal(m.byFlaw.A.n, 2); assert.equal(m.byFlaw.A.handled, 1); assert.equal(m.byFlaw.A.success, 0);
  assert.equal(m.byFlaw.D.handled, 1);
  assert.equal(m.byKind.add_to_cart.n, 5); assert.equal(m.byKind.add_to_cart.success, 2); assert.equal(m.byKind.find.n, 1);
  assert.equal(m.byKind.impossible.handledRate, 1);
});

test('accepts goal sub-object for answer-key fields', () => {
  const m = summarize([{ success: true, ms: 10, steps: 1, tierCounts: { T1_jev: 1 }, goal: { possible: true, kind: 'find', flaw: null } }]);
  assert.equal(m.successPossible, 1); assert.equal(m.byKind.find.n, 1);
});

test('quantile', () => {
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(quantile([5], 0.9), 5);
});
