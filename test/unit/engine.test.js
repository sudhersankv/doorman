'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeFakeDeps } = require('../../src/lib');
const engine = require('../../src/harness/engine');

// ---- hand-crafted snapshots (CONTRACTS §1), generic site: a listing, a detail page, a booking form ----
const listingPage = {
  siteId: 'demo', url: 'http://host/#/list', title: 'Demo Site', templateHash: 'l1',
  actions: [
    { key: 'search', kind: 'type', name: 'Search', role: 'searchbox', selector: '#q', submit: '#f button' },
    { key: 'view_road_racer', kind: 'link', name: 'View Road Racer', role: 'link', selector: 'a[aria-label="View Road Racer"]', href: '#/d/road-racer' },
    { key: 'view_trail_blazer', kind: 'link', name: 'View Trail Blazer', role: 'link', selector: 'a[aria-label="View Trail Blazer"]', href: '#/d/trail-blazer' },
    { key: 'view_city_walker', kind: 'link', name: 'View City Walker', role: 'link', selector: 'a[aria-label="View City Walker"]', href: '#/d/city-walker' },
  ],
  items: [
    { key: 'item_1', text: 'Road Racer $72.00 View Road Racer', attrs: { $: 72 }, actionKeys: ['view_road_racer'] },
    { key: 'item_2', text: 'Trail Blazer $120.00 View Trail Blazer', attrs: { $: 120 }, actionKeys: ['view_trail_blazer'] },
    { key: 'item_3', text: 'City Walker $45.00 View City Walker', attrs: { $: 45 }, actionKeys: ['view_city_walker'] },
  ],
  messages: [], fields: [], counts: { actions: 4, items: 3 },
};

const detailPage = {
  siteId: 'demo', url: 'http://host/#/d/road-racer', title: 'Road Racer', templateHash: 'd1',
  actions: [
    { key: 'size', kind: 'select', name: 'Size', role: 'combobox', selector: '#size', options: [{ value: '9', label: '9' }, { value: '10', label: '10' }] },
    { key: 'add_to_item', kind: 'click', name: 'Add to item', role: 'button', selector: '#add' },
    { key: 'back', kind: 'link', name: 'Back', role: 'link', selector: 'a.back', href: '#/list' },
  ],
  items: [], messages: [], fields: [], counts: { actions: 3, items: 0 },
};

const formPage = {
  siteId: 'demo', url: 'http://host/#/book', title: 'Booking', templateHash: 'f1',
  actions: [
    { key: 'name', kind: 'type', name: 'Name', role: 'textbox', selector: '#name' },
    { key: 'zip', kind: 'type', name: 'ZIP code', role: 'textbox', selector: '#zip' },
    { key: 'submit_booking', kind: 'submit', name: 'Submit booking', role: 'button', selector: '#go' },
  ],
  items: [], messages: [],
  fields: [{ key: 'name', kind: 'text', name: 'Name', selector: '#name', value: '' }, { key: 'zip', kind: 'text', name: 'ZIP code', selector: '#zip', value: '' }],
  counts: { actions: 3, items: 0 },
};

const config = {
  version: 7, tools: { size: { exposed: true, description: 'Pick a size', precondition: 'on a detail page' }, zip: { exposed: true } },
  context: { includeMessages: true, includeItems: true, maxItems: 2, historySteps: 4, recipesTopK: 3 },
  jev: { nextInstructions: 'Choose the single action that moves closest to completing the goal on THIS page. Choose `done` only if the goal is clearly already achieved.', confidenceThreshold: 0.7 },
  guardrails: { confirm: ['submit_booking'], maxSteps: 8, impossibleThreshold: 0.8 },
  rules: ['Prefer the first matching option when several fit'],
};

test('buildState omits selectors, honors maxItems, pre-filters by constraints, carries rules and tool descriptions', () => {
  const s = engine.buildState({ goal: 'view road racer under $100', page: listingPage, history: [], config });
  const json = JSON.stringify(s);
  assert.ok(!/selector|#q|aria-label/.test(json));
  assert.equal(s.itemsTotal, 3);
  assert.equal(s.itemsMatching, 2); // $120 filtered out
  assert.equal(s.items.length, 2); // maxItems
  assert.deepEqual(s.constraints, [{ unit: '$', op: '<=', value: 100 }]);
  assert.deepEqual(s.rules, config.rules);
  assert.ok(json.length <= 6000);
  const d = engine.buildState({ goal: 'x', page: detailPage, config });
  const size = d.actions.find((a) => a.key === 'size');
  assert.equal(size.description, 'Pick a size');
  assert.equal(size.precondition, 'on a detail page');
  assert.deepEqual(size.options, ['9', '10']);
  const noItems = engine.buildState({ goal: 'x', page: listingPage, config: { ...config, context: { ...config.context, includeItems: false, includeMessages: false } } });
  assert.equal(noItems.items, undefined);
  assert.equal(noItems.messages, undefined);
});

test('buildState respects a 6k char budget on a large page', () => {
  const big = { ...listingPage, items: Array.from({ length: 200 }, (_, i) => ({ key: `item_${i}`, text: 'x'.repeat(120), attrs: { $: i }, actionKeys: ['view_road_racer'] })) };
  const s = engine.buildState({ goal: 'anything', page: big, config: { ...config, context: { ...config.context, maxItems: 200 } } });
  assert.ok(JSON.stringify(s).length <= 6000);
});

test('decide (T1 Jev) picks the action named in the goal and fills a select slot', async () => {
  const deps = makeFakeDeps();
  const step = await engine.decide({ goal: 'add to item', page: detailPage, history: [], config, deps });
  assert.equal(step.tier, 'T1_jev');
  assert.equal(step.action, 'add_to_item');
  assert.equal(step.needsConfirmation, false);
  const sized = await engine.decide({ goal: 'choose size 10', page: detailPage, history: [], config, deps });
  assert.equal(sized.action, 'size');
  assert.equal(sized.params.value, '10');
  assert.equal(sized.trace.jevCalls, 2);
  assert.equal(step.trace.configVersion, 7);
  assert.ok(step.trace.jevCalls >= 1 && step.trace.jevCalls <= 2);
  assert.equal(typeof step.trace.jevMs, 'number');
});

test('decide picks a link inside an item on the listing page', async () => {
  const deps = makeFakeDeps();
  const step = await engine.decide({ goal: 'view the trail blazer', page: listingPage, history: [], config, deps });
  assert.equal(step.action, 'view_trail_blazer');
  assert.equal(step.itemKey, 'item_2');
});

test('T0: requestedTool on step 0 executes directly', async () => {
  const deps = makeFakeDeps();
  const step = await engine.decide({ goal: 'whatever', page: { ...listingPage, requestedTool: { key: 'search', params: { text: 'hats' } } }, history: [], config, deps });
  assert.equal(step.tier, 'T0_tool');
  assert.equal(step.action, 'search');
  assert.deepEqual(step.params, { text: 'hats' });
  assert.equal(deps.jev.calls.length, 0);
});

test('confirm gate: needsConfirmation first, proceeds once history confirms', async () => {
  const deps = makeFakeDeps();
  const first = await engine.decide({ goal: 'submit booking', page: formPage, history: [], config, deps });
  assert.equal(first.action, 'submit_booking');
  assert.equal(first.needsConfirmation, true);
  const second = await engine.decide({ goal: 'submit booking', page: formPage, history: [{ action: 'submit_booking', confirmed: true, tier: 'T1_jev' }], config, deps });
  assert.equal(second.action, 'submit_booking');
  assert.equal(second.needsConfirmation, false);
});

test('type action fills text from candidatePhrases', async () => {
  const deps = makeFakeDeps();
  const page = { ...listingPage, actions: [listingPage.actions[0]], items: [] };
  const step = await engine.decide({ goal: 'search for running shoes under $80', page, history: [], config, deps });
  assert.equal(step.action, 'search');
  assert.ok(['running shoes', 'running shoe', 'shoes', 'running'].includes(step.params.text), step.params.text);
});

test('T2: low Jev confidence falls back to the LLM, which must name an existing action', async () => {
  const deps = makeFakeDeps({ llmHandlers: { decide: (msgs) => { assert.ok(/ALLOWED ACTION KEYS/.test(msgs[1].content)); return { action: 'size', params: { value: '9' }, done: false, impossible: false, reason: 'llm says size' }; } } });
  const real = deps.jev.decide.bind(deps.jev);
  deps.jev.decide = async (state, qs) => { const r = await real(state, qs); if (r.answers.next) r.answers.next.confidence = 0.2; return r; };
  const step = await engine.decide({ goal: 'add to item', page: detailPage, history: [], config, deps });
  assert.equal(step.tier, 'T2_llm');
  assert.equal(step.action, 'size');
  assert.deepEqual(step.params, { value: '9' });
  assert.equal(deps.llm.calls(), 1);
  assert.ok(step.trace.llmMs >= 0);
  // unknown action from the LLM is rejected; the engine then falls back to Jev's own top choice instead of stalling
  const deps2 = makeFakeDeps({ llmHandlers: { decide: () => ({ action: 'nope' }) } });
  deps2.jev.decide = async () => ({ answers: { next: { choice: 'size', confidence: 0.1 }, feasible: { noul: 0.9 } }, ms: 1 });
  const s2 = await engine.decide({ goal: 'add to item', page: detailPage, history: [], config, deps: deps2 });
  assert.equal(s2.tier, 'T1_jev');
  assert.equal(s2.action, 'size');
  assert.match(s2.reason, /llm unusable/);
  // and with no Jev choice at all, the null step is returned
  const deps3 = makeFakeDeps({ llmHandlers: { decide: () => ({ action: 'nope' }) } });
  deps3.jev.decide = async () => ({ answers: { next: { choice: null, confidence: 0 }, feasible: { noul: 0.9 } }, ms: 1 });
  const s3 = await engine.decide({ goal: 'add to item', page: detailPage, history: [], config, deps: deps3 });
  assert.equal(s3.tier, 'T2_llm');
  assert.equal(s3.action, null);
});

test('Jev throwing falls back to T2; LLM throwing returns an error step', async () => {
  const deps = makeFakeDeps({ llmHandlers: { decide: () => ({ action: 'add_to_item' }) } });
  deps.jev.decide = async () => { throw new Error('jev down'); };
  const step = await engine.decide({ goal: 'add to item', page: detailPage, history: [], config, deps });
  assert.equal(step.tier, 'T2_llm');
  assert.equal(step.action, 'add_to_item');
  deps.llm.chat = async () => { throw new Error('llm down'); };
  const bad = await engine.decide({ goal: 'add to item', page: detailPage, history: [], config, deps });
  assert.equal(bad.action, null);
  assert.equal(bad.done, false);
  assert.match(bad.error, /llm down/);
});

test('impossible detection when the fake Jev finds the goal infeasible on early steps', async () => {
  const deps = makeFakeDeps();
  const page = { ...listingPage, items: [], messages: [{ role: 'alert', text: 'Sorry, not found.' }] };
  const step = await engine.decide({ goal: 'view the purple widget', page, history: [], config, deps });
  assert.equal(step.impossible, true);
  assert.equal(step.action, null);
  assert.equal(step.tier, 'T1_jev');
  // not applied after step 1
  const later = await engine.decide({ goal: 'view the purple widget', page, history: [{}, {}, {}], config, deps });
  assert.equal(later.impossible, false);
});

test('done when Jev chooses done', async () => {
  const deps = makeFakeDeps();
  deps.jev.decide = async () => ({ answers: { next: { choice: 'done', confidence: 0.95 }, feasible: { noul: 0.9 } }, ms: 2 });
  const step = await engine.decide({ goal: 'anything', page: detailPage, history: [{}], config, deps });
  assert.equal(step.done, true);
  assert.equal(step.action, null);
});

test('verifyOutcome: failureReason from messages, null when satisfied', async () => {
  const deps = makeFakeDeps();
  const failed = await engine.verifyOutcome({ goal: 'book a visit', finalPage: { ...formPage, messages: [{ role: 'alert', text: 'Login required: please sign in to continue' }] }, history: [{ action: 'submit_booking', outcome: 'error', messagesAfter: ['Login required: please sign in to continue'] }], deps });
  assert.ok(failed.satisfied < 0.5);
  assert.equal(failed.failureReason, 'login_required');
  assert.equal(deps.jev.calls.length, 1);
  const ok = await engine.verifyOutcome({ goal: 'book a visit', finalPage: { ...formPage, messages: [{ role: 'status', text: 'Thank you, your booking is placed.' }] }, history: [], deps });
  assert.ok(ok.satisfied >= 0.5);
  assert.equal(ok.failureReason, null);
});

test('recipe tier is used when deps.recipes.find returns a high-score recipe (blanks filled via Jev)', async () => {
  const deps = makeFakeDeps();
  let findArgs;
  deps.recipes = { find: async (args) => { findArgs = args; return [{ _id: 'r1', goalPattern: 'add $X in size $Y', score: 0.92, steps: [{ action: 'size', params: { value: '$BLANK' } }, { action: 'add_to_item', params: {} }] }]; } };
  const step = await engine.decide({ goal: 'add to item in size 10', page: detailPage, history: [], config, deps });
  assert.equal(step.tier, 'T1_recipe');
  assert.equal(step.action, 'size');
  assert.equal(step.params.value, '10');
  assert.equal(step.trace.recipeId, 'r1');
  assert.equal(findArgs.siteId, 'demo');
  assert.equal(findArgs.topK, 3);
  assert.ok(Array.isArray(findArgs.goalVector));
  // second step of the recipe
  const s2 = await engine.decide({ goal: 'add to item in size 10', page: detailPage, history: [step], config, deps, goalVector: findArgs.goalVector });
  assert.equal(s2.tier, 'T1_recipe');
  assert.equal(s2.action, 'add_to_item');
  // low score -> falls through to Jev
  deps.recipes.find = async () => [{ _id: 'r2', score: 0.3, steps: [{ action: 'back' }] }];
  const s3 = await engine.decide({ goal: 'add to item', page: detailPage, history: [], config, deps });
  assert.equal(s3.tier, 'T1_jev');
  // recipe action missing on this page -> falls through
  deps.recipes.find = async () => [{ _id: 'r3', score: 0.99, steps: [{ action: 'not_here' }] }];
  const s4 = await engine.decide({ goal: 'add to item', page: detailPage, history: [], config, deps });
  assert.equal(s4.tier, 'T1_jev');
});

test('questionsFor helpers expose the Jev questions', () => {
  const next = engine.questionsForNext({ page: detailPage, config });
  assert.equal(next.next.type, 'choice');
  assert.ok(next.next.criteria.done);
  assert.match(next.next.criteria.size, /select Size — Pick a size/);
  assert.equal(next.feasible.type, 'noul');
  assert.equal(next.needs_confirmation.type, 'noul');
  const slots = engine.questionsForSlots({ goal: 'size 10', page: detailPage, action: detailPage.actions[0], config });
  assert.deepEqual(Object.keys(slots.value.criteria), ['9', '10']);
  const text = engine.questionsForSlots({ goal: 'search for running shoes', page: listingPage, action: listingPage.actions[0], config });
  assert.ok(Object.keys(text.text.criteria).length >= 3);
  const v = engine.questionsForVerify();
  assert.deepEqual(Object.keys(v.failure_reason.criteria), engine.FAILURE_REASONS);
  // selectors never leak into questions
  assert.ok(!/selector|#size/.test(JSON.stringify([next, slots, text])));
});
