'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeFakeDeps } = require('../../src/lib');
const visits = require('../../src/harness/visits');

const step = (action, tier, outcome = 'ok', messagesAfter = []) => ({ action, params: {}, tier, confidence: 0.8, outcome, messagesAfter });

test('log inserts with createdAt and derived tierCounts', async () => {
  const deps = makeFakeDeps();
  const v = await visits.log({ siteId: 's', visitId: 'v1', goal: 'g', history: [step('a', 'T1_jev'), step('b', 'T2_llm')], outcome: 'success', ms: 100, configVersion: 1, deps });
  assert.ok(v._id); assert.ok(typeof v.createdAt === 'string');
  assert.deepEqual(v.tierCounts, { T1_jev: 1, T2_llm: 1 });
  assert.equal(await deps.db.col('visits').countDocuments({ siteId: 's' }), 1);
});

test('worst + metrics', async () => {
  const deps = makeFakeDeps();
  const base = { siteId: 's', configVersion: 1, deps };
  await visits.log({ ...base, goal: 'ok one', history: [step('a', 'T1_jev'), step('b', 'T1_jev')], outcome: 'success', ms: 100, tierCounts: { T1_jev: 2 } });
  await visits.log({ ...base, goal: 'ok two', history: [step('a', 'T1_recipe')], outcome: 'success', ms: 300, tierCounts: { T1_recipe: 1 } });
  await visits.log({ ...base, goal: 'fail long', history: [step('a', 'T1_jev'), step('b', 'T2_llm', 'error', [{ role: 'alert', text: 'm1' }, { role: 'status', text: 'm2' }, { role: 'status', text: 'm3' }]), step('c', 'T2_llm')],
    outcome: 'failed', failureReason: 'not_found', ms: 500, tierCounts: { T1_jev: 1, T2_llm: 2 } });
  await visits.log({ ...base, goal: 'fail short', history: [step('a', 'T1_jev')], outcome: 'failed', failureReason: 'not_found', ms: 200, tierCounts: { T1_jev: 1 } });
  await visits.log({ ...base, goal: 'impossible unreported', history: [step('a', 'T1_jev'), step('b', 'T1_jev')], outcome: 'impossible', failureReason: 'unavailable', ms: 400, tierCounts: { T1_jev: 2 }, agentReported: { done: false, impossible: false } });
  await visits.log({ ...base, goal: 'impossible reported', history: [step('a', 'T1_jev')], outcome: 'impossible', failureReason: 'unavailable', ms: 50, tierCounts: { T1_jev: 1 }, agentReported: { done: false, impossible: true } });
  await visits.log({ ...base, configVersion: 2, goal: 'other version', history: [step('a', 'T2_llm')], outcome: 'failed', failureReason: 'other', ms: 999, tierCounts: { T2_llm: 1 } });
  await visits.log({ ...base, siteId: 'other', goal: 'other site', history: [], outcome: 'failed', failureReason: 'other', ms: 1, tierCounts: {} });

  const w = await visits.worst({ siteId: 's', configVersion: 1, deps });
  assert.deepEqual(w.map((t) => t.goal), ['fail long', 'impossible unreported', 'fail short']);
  assert.equal(w[0].failureReason, 'not_found');
  assert.deepEqual(w[0].steps[1], { action: 'b', tier: 'T2_llm', confidence: 0.8, outcome: 'error', messagesAfter: ['m1', 'm2'] });
  assert.ok(!('params' in w[0].steps[0]));
  assert.equal((await visits.worst({ siteId: 's', configVersion: 1, limit: 1, deps })).length, 1);
  assert.equal((await visits.worst({ siteId: 's', deps })).length, 4);

  const m = await visits.metrics({ siteId: 's', configVersion: 1, deps });
  assert.equal(m.n, 6);
  assert.equal(m.successRate, 2 / 6);
  assert.deepEqual(m.failureReasons, { not_found: 2, unavailable: 2 });
  assert.equal(m.medianMs, 250); // sorted: 50,100,200,300,400,500
  assert.deepEqual(m.tierCounts, { T1_jev: 7, T1_recipe: 1, T2_llm: 2 });
  assert.equal(m.llmFallbackRate, 2 / 10);

  const empty = await visits.metrics({ siteId: 'nobody', deps });
  assert.deepEqual(empty, { n: 0, successRate: 0, failureReasons: {}, medianMs: 0, llmFallbackRate: 0, tierCounts: {} });
});
