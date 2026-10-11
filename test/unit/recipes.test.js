'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeFakeDeps } = require('../../src/lib');
const recipes = require('../../src/harness/recipes');

const history = [
  { action: 'search', params: { text: 'blue widget' }, tier: 'T1_jev', confidence: 0.9, outcome: 'ok', messagesAfter: [] },
  { action: 'size', params: { value: '9' }, tier: 'T1_jev', confidence: 0.8, outcome: 'ok', messagesAfter: [] },
  { action: 'broken_step', params: {}, tier: 'T2_llm', confidence: 0.4, outcome: 'error', messagesAfter: [{ role: 'alert', text: 'nope' }] },
  { action: 'open_thing', params: {}, tier: 'T1_jev', confidence: 0.95, outcome: 'ok', messagesAfter: [] },
];

test('toGoalPattern replaces numbers and quoted phrases', () => {
  assert.equal(recipes.toGoalPattern('buy X under $80'), 'buy X under $N');
  assert.equal(recipes.toGoalPattern('find "wool socks" rated 4.5 stars'), 'find "X" rated N stars');
});

test('saveFromHistory blanks text/values, keeps only ok steps; identical save increments successes', async () => {
  const deps = makeFakeDeps();
  const [vec] = await deps.embed.embed(['buy blue widget size 9 under $80']);
  const r1 = await recipes.saveFromHistory({ siteId: 's', goal: 'buy blue widget size 9 under $80', goalVector: vec, history, deps });
  assert.equal(r1.goalPattern, 'buy blue widget size N under $N');
  assert.deepEqual(r1.steps, [
    { action: 'search', params: { text: '$BLANK' } },
    { action: 'size', params: { value: '$BLANK' } },
    { action: 'open_thing', params: {} },
  ]);
  assert.equal(r1.successes, 1); assert.equal(r1.failures, 0); assert.equal(r1.brokenAt, null);

  const r2 = await recipes.saveFromHistory({ siteId: 's', goal: 'buy red widget size 10 under $50', goalVector: vec, history, deps });
  assert.equal(String(r2._id), String(r1._id));
  assert.equal(r2.successes, 2);
  assert.equal(await deps.db.col('recipes').countDocuments({ siteId: 's' }), 1);

  // different site -> separate recipe
  const r3 = await recipes.saveFromHistory({ siteId: 'other', goal: 'x', goalVector: vec, history, deps });
  assert.notEqual(String(r3._id), String(r1._id));

  // nothing succeeded -> null
  assert.equal(await recipes.saveFromHistory({ siteId: 's', goal: 'x', goalVector: vec, history: [history[2]], deps }), null);
});

test('find returns by similarity, filters by site, skips broken, honors minScore/topK', async () => {
  const deps = makeFakeDeps();
  const [vA, vB, vC] = await deps.embed.embed(['buy blue widget under $80', 'return an item I received yesterday', 'buy green widget under $20']);
  const a = await recipes.saveFromHistory({ siteId: 's', goal: 'buy blue widget under $80', goalVector: vA, history: [history[0]], deps });
  const b = await recipes.saveFromHistory({ siteId: 's', goal: 'return an item I received yesterday', goalVector: vB, history: [history[1]], deps });
  const c = await recipes.saveFromHistory({ siteId: 's', goal: 'buy green widget under $20', goalVector: vC, history: [history[0], history[3]], deps });
  await recipes.saveFromHistory({ siteId: 'elsewhere', goal: 'buy blue widget under $80', goalVector: vA, history: [history[0]], deps });

  const [q] = await deps.embed.embed(['buy blue widget under $90']);
  const found = await recipes.find({ siteId: 's', goalVector: q, topK: 3, deps });
  assert.equal(found.length, 3);
  assert.equal(String(found[0]._id), String(a._id));
  assert.ok(found[0].score >= found[1].score && found[1].score >= found[2].score);
  assert.equal(String(found[2]._id), String(b._id));
  for (const f of found) { assert.ok(!('goalEmbedding' in f)); assert.ok(Array.isArray(f.steps)); assert.equal(typeof f.successes, 'number'); }

  const broken = await recipes.markBroken(a._id, deps);
  assert.ok(broken.brokenAt); assert.equal(broken.failures, 1);
  const after = await recipes.find({ siteId: 's', goalVector: q, topK: 3, deps });
  assert.ok(!after.some((f) => String(f._id) === String(a._id)));
  assert.equal(String(after[0]._id), String(c._id));

  const rf = await recipes.recordFailure(c._id, deps);
  assert.equal(rf.failures, 1); assert.equal(rf.brokenAt, null);

  assert.equal((await recipes.find({ siteId: 's', goalVector: q, topK: 1, deps })).length, 1);
  assert.equal((await recipes.find({ siteId: 's', goalVector: q, minScore: 1.01, deps })).length, 0);
  assert.deepEqual(await recipes.find({ siteId: 's', goalVector: [], deps }), []);
});
