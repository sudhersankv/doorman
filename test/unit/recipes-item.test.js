'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const recipes = require('../../src/harness/recipes');
const engine = require('../../src/harness/engine');
const { makeFakeDeps } = require('../../src/lib');

test('steps inside a repeated item are stored generically as $ITEM and replay on another item', async () => {
  const history = [
    { action: 'view_alpha', params: {}, outcome: 'ok', itemKey: 'item_1', kind: 'link' },
    { action: 'size', params: { value: '9' }, outcome: 'ok', kind: 'select' },
    { action: 'add_to_item', params: {}, outcome: 'ok', kind: 'click' },
  ];
  const steps = recipes.stepsFromHistory(history);
  assert.deepEqual(steps[0], { action: '$ITEM', kind: 'link', params: {} });
  assert.deepEqual(steps[1], { action: 'size', params: { value: '$BLANK' } });

  // replay: a listing with two items; the goal names the second one
  const deps = makeFakeDeps();
  const [vec] = await deps.embed.embed(['get the beta thing'], 'query');
  deps.recipes = { find: async () => [{ _id: 'r1', goalPattern: 'get the alpha thing', steps, score: 0.95, successes: 1, failures: 0 }] };
  const page = { siteId: 's', url: 'x', templateHash: 'h', messages: [], fields: [],
    actions: [{ key: 'view_alpha', kind: 'link', name: 'View Alpha', selector: 'a1' }, { key: 'view_beta', kind: 'link', name: 'View Beta', selector: 'a2' }],
    items: [{ key: 'item_1', text: 'Alpha thing $10', attrs: { $: 10 }, actionKeys: ['view_alpha'] }, { key: 'item_2', text: 'Beta thing $20', attrs: { $: 20 }, actionKeys: ['view_beta'] }] };
  const step = await engine.decide({ goal: 'get the beta thing', page, history: [], config: engine.withDefaults({ siteId: 's', jev: { confidenceThreshold: 0.5 } }), deps, goalVector: vec });
  assert.equal(step.tier, 'T1_recipe');
  assert.equal(step.action, 'view_beta');
  assert.equal(step.itemKey, 'item_2');
});
