'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createServer } = require('../../server');
const { makeFakeDeps } = require('../../src/lib');

/** Scripted engine: returns one step per call, verifies by looking at the final page's messages. */
function fakeEngine(script) {
  let i = 0; const calls = [];
  return {
    calls,
    async decide(args) { calls.push(args); const s = script[Math.min(i++, script.length - 1)]; return { ...s, trace: { jevMs: 3 } }; },
    async verifyOutcome({ finalPage }) { const ok = (finalPage?.messages || []).some((m) => /added/i.test(m.text)); return { satisfied: ok ? 1 : 0, failureReason: ok ? null : 'other' }; },
  };
}
const PAGE = { siteId: 'trailhead', url: 'http://x/shop/#/product/road-racer', title: 'T', templateHash: 'h1', actions: [{ key: 'size', kind: 'select', name: 'Size', options: [{ value: '9', label: '9' }] }, { key: 'add_to_cart', kind: 'click', name: 'Add to cart' }, { key: 'place_order', kind: 'submit', name: 'Place order' }], items: [], messages: [], fields: [], counts: { actions: 3, items: 0 } };

function listen(server) { return new Promise((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`))); }
async function req(base, method, p, body) {
  const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, headers: res.headers, text, json };
}

test('server routes', async (t) => {
  const deps = makeFakeDeps();
  const engine = fakeEngine([
    { action: 'size', params: { value: '9' }, tier: 'T1_jev', confidence: 0.9, done: false, impossible: false, needsConfirmation: false, reason: 'pick size' },
    { action: 'add_to_cart', params: {}, tier: 'T1_jev', confidence: 0.95, done: false, impossible: false, needsConfirmation: false, reason: 'add' },
    { action: null, params: {}, tier: 'T1_jev', confidence: 0.99, done: true, impossible: false, needsConfirmation: false, reason: 'done' },
  ]);
  const server = createServer({ deps, engine, siteDefaults: { siteId: 'trailhead' } });
  const base = await listen(server);
  t.after(() => server.close());

  await t.test('GET /health', async () => { const r = await req(base, 'GET', '/health'); assert.equal(r.status, 200); assert.equal(r.json.ok, true); assert.equal(r.headers.get('access-control-allow-origin'), '*'); });

  await t.test('static shop + doorman.js', async () => {
    const idx = await req(base, 'GET', '/shop/');
    assert.equal(idx.status, 200); assert.match(idx.headers.get('content-type'), /text\/html/); assert.match(idx.text, /Trailhead Outfitters/);
    const deep = await req(base, 'GET', '/shop/anything/not/here'); assert.equal(deep.status, 200); assert.match(deep.text, /<!doctype html>/i);
    const js = await req(base, 'GET', '/shop/shop.js'); assert.equal(js.status, 200); assert.match(js.headers.get('content-type'), /javascript/);
    const dj = await req(base, 'GET', '/doorman.js');
    if (dj.status === 200) assert.match(dj.headers.get('content-type'), /javascript/); else assert.equal(dj.json.error, 'not found'); // public/doorman.js is written by another agent
    const trav = await req(base, 'GET', '/shop/../../package.json'); assert.notEqual(trav.text.slice(0, 1), '{' === trav.text.slice(0, 1) && trav.text.includes('"dependencies"') ? '{' : '');
    assert.ok(!trav.text.includes('"dependencies"'));
  });

  await t.test('POST /api/map + manifest', async () => {
    const r = await req(base, 'POST', '/api/map', { ...PAGE });
    assert.equal(r.status, 200); assert.equal(r.json.ok, true);
    await req(base, 'POST', '/api/map', { ...PAGE }); // upsert, not duplicate
    assert.equal(deps.db.store.site_maps.length, 1); assert.equal(deps.db.store.site_maps[0].seen, 2);
    const m = await req(base, 'GET', '/.well-known/doorman.json');
    assert.equal(m.status, 200); assert.equal(m.json.siteId, 'trailhead'); assert.ok(m.json.version);
    assert.equal(m.json.endpoints.decide, '/api/decide');
    assert.deepEqual(m.json.tools.map((x) => x.name), ['size', 'add_to_cart', 'place_order']);
    assert.deepEqual(m.json.tools[0].inputSchema.properties.value.enum, ['9']);
  });

  let visitId;
  await t.test('POST /api/decide assigns a visitId and returns a step', async () => {
    const r1 = await req(base, 'POST', '/api/decide', { siteId: 'trailhead', goal: 'add road racer size 9', page: PAGE, history: [] });
    assert.equal(r1.status, 200); assert.ok(r1.json.visitId && r1.json.visitId.length > 10); visitId = r1.json.visitId;
    assert.equal(r1.json.step.action, 'size'); assert.equal(r1.json.step.tier, 'T1_jev'); assert.equal(r1.json.step.done, false);
    assert.equal(r1.json.trace.configVersion, 1); assert.equal(r1.json.trace.jevMs, 3);
    assert.equal(engine.calls[0].config.siteId, 'trailhead'); assert.ok(Array.isArray(engine.calls[0].goalVector));
    const r2 = await req(base, 'POST', '/api/decide', { siteId: 'trailhead', goal: 'add road racer size 9', page: PAGE, history: [{ action: 'size', tier: 'T1_jev', outcome: 'ok' }], visitId });
    assert.equal(r2.json.visitId, visitId); assert.equal(r2.json.step.action, 'add_to_cart');
    assert.deepEqual(engine.calls[1].goalVector, engine.calls[0].goalVector); // cached per visit
    assert.ok(deps.db.store.harness_configs.length === 1 && deps.db.store.harness_configs[0].guardrails.confirm.includes('place_order'));
  });

  await t.test('validation errors are JSON', async () => {
    const r = await req(base, 'POST', '/api/decide', { siteId: 'trailhead', page: PAGE });
    assert.equal(r.status, 400); assert.match(r.json.error, /goal/);
    const bad = await req(base, 'POST', '/api/decide', null); assert.equal(bad.status, 400);
    const nf = await req(base, 'GET', '/api/nope'); assert.equal(nf.status, 404); assert.ok(nf.json.error);
  });

  await t.test('POST /api/visit stores a visit and saves a recipe on success', async () => {
    const history = [{ action: 'size', params: { value: '9' }, tier: 'T1_jev', confidence: 0.9, outcome: 'ok', messagesAfter: [] }, { action: 'add_to_cart', params: {}, tier: 'T2_llm', confidence: 0.8, outcome: 'ok', messagesAfter: [{ role: 'status', text: 'Added to cart.' }] }];
    const finalPage = { ...PAGE, messages: [{ role: 'status', text: 'Added to cart.' }] };
    const r = await req(base, 'POST', '/api/visit', { visitId, siteId: 'trailhead', goal: 'add road racer size 9', history, finalPage, agentReported: { done: true, impossible: false } });
    assert.equal(r.status, 200); assert.equal(r.json.ok, true);
    assert.equal(r.json.visit.outcome, 'success'); assert.equal(r.json.visit.failureReason, null); assert.equal(r.json.visit.recipeSaved, true);
    assert.deepEqual(r.json.visit.tierCounts, { T1_jev: 1, T2_llm: 1 }); assert.ok(r.json.visit.ms >= 0);
    assert.equal(deps.db.store.visits.length, 1); assert.equal(deps.db.store.visits[0].outcome, 'success'); assert.equal(deps.db.store.visits[0].configVersion, 1);
    assert.equal(deps.db.store.recipes.length, 1); assert.deepEqual(deps.db.store.recipes[0].steps.map((s) => s.action), ['size', 'add_to_cart']);
    // impossible reported
    const r2 = await req(base, 'POST', '/api/visit', { siteId: 'trailhead', goal: 'kids shoes', history: [], finalPage: PAGE, agentReported: { done: false, impossible: true } });
    assert.equal(r2.json.visit.outcome, 'impossible'); assert.equal(deps.db.store.visits.length, 2);
    // failed
    const r3 = await req(base, 'POST', '/api/visit', { siteId: 'trailhead', goal: 'x', history: [], finalPage: PAGE, agentReported: { done: true, impossible: false } });
    assert.equal(r3.json.visit.outcome, 'failed'); assert.equal(r3.json.visit.failureReason, 'other'); assert.equal(deps.db.store.recipes.length, 1);
  });

  await t.test('GET /api/config, /api/evolution, /api/runs', async () => {
    const c = await req(base, 'GET', '/api/config?site=trailhead');
    assert.equal(c.status, 200); assert.equal(c.json.version, 1); assert.equal(c.json.active, true);
    assert.ok(!JSON.stringify(c.json).match(/mongodb\+srv|api[_-]?key|token/i));
    const e = await req(base, 'GET', '/api/evolution?site=trailhead');
    assert.equal(e.json.versions.length, 1); assert.equal(e.json.versions[0].metrics.n, 3); assert.equal(e.json.versions[0].verdict, null);
    await deps.db.col('runs').insertOne({ runId: 'r1', siteId: 'trailhead', split: 'heldout', configVersion: 1, startedAt: 'a', finishedAt: 'b', metrics: { n: 2 }, results: [{}, {}] });
    const r = await req(base, 'GET', '/api/runs?site=trailhead');
    assert.equal(r.json.runs.length, 1); assert.equal(r.json.runs[0].n, 2); assert.equal(r.json.runs[0].results, undefined);
  });

  await t.test('body limit', async () => {
    const r = await req(base, 'POST', '/api/map', { templateHash: 'x', actions: [], pad: 'x'.repeat(1024 * 1024 + 10) });
    assert.equal(r.status, 413);
  });
});

test('createServer requires deps and tolerates a missing engine', async (t) => {
  assert.throws(() => createServer({}), /deps/);
  const server = createServer({ deps: makeFakeDeps(), engine: null });
  const base = await listen(server); t.after(() => server.close());
  const r = await req(base, 'POST', '/api/decide', { goal: 'x', page: PAGE });
  assert.ok(r.status === 503 || r.status === 200); // 503 when src/harness/engine.js is absent, 200 when the real engine is present
});
