'use strict';
// Unit/browser tests for public/doorman.js. Runs a tiny static server with a scripted /api/decide.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..', '..');
const PUBLIC = path.join(ROOT, 'public');
const FIXTURES = path.join(ROOT, 'test', 'fixtures');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

// ---- scripted mock API ------------------------------------------------------
const mock = { steps: [], decideCalls: [], visitCalls: [] };
function handleApi(req, res, body) {
  if (req.url === '/api/decide') {
    mock.decideCalls.push(body);
    const step = mock.steps.length ? mock.steps.shift() : { action: null, done: true };
    const full = Object.assign({ action: null, params: {}, tier: 'T1_recipe', confidence: 0.9, done: false, impossible: false, needsConfirmation: false, reason: 'scripted' }, step);
    return json(res, { visitId: 'v-test', step: full, trace: { jevMs: 0, llmMs: 0, configVersion: 1 } });
  }
  if (req.url === '/api/visit') {
    mock.visitCalls.push(body);
    return json(res, { ok: true, visit: { outcome: body.agentReported.done ? 'success' : 'failed', failureReason: null, ms: 1, tierCounts: {}, recipeSaved: false } });
  }
  res.writeHead(404); res.end();
}
function json(res, obj) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); }

function serveStatic(req, res) {
  let p = req.url.split('?')[0].split('#')[0];
  let file;
  if (p.startsWith('/fixtures/')) file = path.join(FIXTURES, p.slice('/fixtures/'.length));
  else { if (p.endsWith('/')) p += 'index.html'; file = path.join(PUBLIC, p); }
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

let server, base, browser, page;
before(async () => {
  server = http.createServer((req, res) => {
    if (req.method === 'POST') {
      let buf = ''; req.on('data', (c) => { buf += c; });
      req.on('end', () => handleApi(req, res, buf ? JSON.parse(buf) : {}));
      return;
    }
    serveStatic(req, res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
  page = await browser.newPage();
  page.on('pageerror', (e) => { throw e; });
});
after(async () => { if (browser) await browser.close(); if (server) server.close(); });
beforeEach(() => { mock.steps = []; mock.decideCalls = []; mock.visitCalls = []; });

const gotoShop = async (hash) => {
  await page.goto(`${base}/shop/${hash || '#/'}`, { waitUntil: 'load' });
  await page.evaluate(() => { window.shopReset(); localStorage.clear(); });
  if (hash) await page.evaluate((h) => { location.hash = h; }, hash);
  await page.waitForFunction(() => window.doorman && document.querySelector('#app').children.length > 0);
};
const snap = () => page.evaluate(() => window.doorman.map());

// ---- (a) snapshot --------------------------------------------------------------
test('(a) shop listing snapshot: actions, items, templateHash', async () => {
  await gotoShop('#/');
  const s = await snap();
  assert.equal(s.siteId, 'trailhead');
  assert.equal(typeof s.templateHash, 'string');
  const search = s.actions.find((a) => a.kind === 'type' && a.role === 'searchbox');
  assert.ok(search, 'search action');
  assert.equal(search.selector, '#search');
  assert.ok(search.submit, 'search has submit selector');
  assert.equal(await page.$eval(search.submit, (b) => b.textContent.trim()), 'Search');
  const cat = s.actions.find((a) => a.key === 'category');
  assert.ok(cat && cat.kind === 'select', 'category select');
  assert.ok(cat.options.length >= 5 && cat.options.some((o) => o.value === 'boots'));
  const links = s.actions.filter((a) => a.kind === 'link' && /^view_/.test(a.key));
  assert.ok(links.length >= 10, 'link per card');
  assert.ok(links.every((l) => l.href && l.href.startsWith('#/')));
  assert.ok(s.items.length >= 10, 'items >= 10');
  assert.ok(s.items.every((i) => typeof i.attrs.$ === 'number'), 'items have $');
  const rr = s.items.find((i) => /Road Racer/.test(i.text));
  assert.equal(rr.attrs.$, 72);
  assert.ok(rr.actionKeys.includes('view_road_racer'));
  assert.equal(s.counts.actions, s.actions.length);
  // unique keys and selectors
  assert.equal(new Set(s.actions.map((a) => a.key)).size, s.actions.length);
  assert.equal(new Set(s.actions.map((a) => a.selector)).size, s.actions.length);
  // fields subset of actions
  assert.ok(s.fields.some((f) => f.key === search.key && f.value === ''));

  const listingHash = s.templateHash;
  await page.evaluate(() => { location.hash = '#/product/road-racer'; });
  await page.waitForFunction(() => !!document.querySelector('#add'));
  const p1 = await snap();
  await page.evaluate(() => { location.hash = '#/product/trail-runner'; });
  await page.waitForFunction(() => /Trail Runner/.test(document.querySelector('h1').textContent));
  const p2 = await snap();
  assert.equal(p1.templateHash, p2.templateHash, 'two pages of one template share a hash');
  assert.notEqual(p1.templateHash, listingHash, 'listing differs');
  const size = p1.actions.find((a) => a.key === 'size');
  assert.ok(size && size.options.some((o) => o.value === '9'));
  assert.ok(p1.actions.some((a) => a.key === 'add_to_cart' && a.kind === 'click' && a.selector === '#add'));
});

// ---- (b) executor -------------------------------------------------------------
test('(b) executor: select + click, type + submit', async () => {
  await gotoShop('#/product/road-racer');
  await page.evaluate(() => window.doorman.map());
  let rec = await page.evaluate(() => window.doorman.act('size', { value: '9' }));
  assert.equal(rec.outcome, 'ok');
  rec = await page.evaluate(() => window.doorman.act('add_to_cart'));
  assert.equal(rec.outcome, 'ok');
  assert.ok(rec.messagesAfter.some((m) => m.role === 'status' && /Added/.test(m.text)), 'status message captured');
  const state = await page.evaluate(() => window.shopState());
  assert.equal(state.cart.length, 1);
  assert.equal(state.cart[0].size, 9);

  rec = await page.evaluate(() => window.doorman.act('search_products', { text: 'rain' }));
  assert.equal(rec.outcome, 'ok');
  assert.match(await page.evaluate(() => location.hash), /q=rain/);
  assert.match(await page.$eval('h1', (h) => h.textContent), /rain/);
  const s = await snap();
  const hits = s.actions.filter((a) => /^view_/.test(a.key));
  assert.ok(hits.length >= 2 && hits.length < 10, 'search narrowed the listing');
  assert.ok(hits.every((a) => /rain/i.test(a.name) || /rain/i.test(a.href)) || s.items.length === hits.length);
});

// ---- (c) do() loop --------------------------------------------------------------
test('(c) doorman.do runs scripted steps and reports the visit', async () => {
  await gotoShop('#/');
  mock.steps = [
    { action: 'view_road_racer', tier: 'T1_recipe' },
    { action: 'size', params: { value: '9' }, tier: 'T1_jev' },
    { action: 'add_to_cart', tier: 'T1_jev' },
    { action: null, done: true, tier: 'T1_jev' },
  ];
  const events = [];
  await page.exposeFunction('__onEvt', (d) => events.push(d));
  await page.evaluate(() => window.addEventListener('doorman:step', (e) => window.__onEvt({ index: e.detail.index, action: e.detail.step.action })));
  const res = await page.evaluate(() => window.doorman.do('buy running shoes size 9'));
  assert.equal(res.ok, true);
  assert.equal(res.done, true);
  assert.equal(res.steps.length, 3);
  assert.equal(res.visitId, 'v-test');
  assert.deepEqual(res.tierCounts, { T1_recipe: 1, T1_jev: 3 });
  assert.ok(res.steps.every((s) => s.outcome === 'ok'));
  assert.equal(mock.decideCalls.length, 4);
  assert.equal(mock.decideCalls[0].siteId, 'trailhead');
  assert.equal(mock.decideCalls[1].history.length, 1);
  assert.equal(mock.decideCalls[1].visitId, 'v-test');
  assert.equal(mock.visitCalls.length, 1);
  assert.equal(mock.visitCalls[0].history.length, 3);
  assert.deepEqual(mock.visitCalls[0].agentReported, { done: true, impossible: false });
  assert.ok(mock.visitCalls[0].finalPage.actions.length > 0);
  assert.equal((await page.evaluate(() => window.shopState())).cart.length, 1);
  assert.equal(events.length, 4);

  // needsConfirmation without autoConfirm stops; with autoConfirm it continues.
  mock.steps = [{ action: 'add_to_cart', needsConfirmation: true }]; mock.decideCalls = [];
  const r2 = await page.evaluate(() => window.doorman.do('add again'));
  assert.equal(r2.needsConfirmation, true);
  assert.equal(mock.decideCalls.length, 1);
  mock.steps = [{ action: 'add_to_cart', needsConfirmation: true }, { action: 'add_to_cart' }, { action: null, done: true }]; mock.decideCalls = [];
  const r3 = await page.evaluate(() => window.doorman.do('add again', { autoConfirm: true }));
  assert.equal(r3.done, true);
  assert.equal(mock.decideCalls[1].history[0].confirmed, true);

  // maxSteps caps the loop
  mock.steps = Array.from({ length: 5 }, () => ({ action: 'quantity', params: { value: '2' } }));
  const r4 = await page.evaluate(() => window.doorman.do('spin', { maxSteps: 2 }));
  assert.equal(r4.steps.length, 2);

  // unreachable server never throws
  const bad = await page.evaluate(() => window.doorman.do('anything', { apiBase: 'http://127.0.0.1:1' }));
  assert.equal(bad.ok, false);
  assert.ok(bad.error);
});

// ---- (d) clinic fixture ---------------------------------------------------------
test('(d) clinic.html: generic items, attrs and book action', async () => {
  await page.goto(`${base}/fixtures/clinic.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.doorman);
  const s = await snap();
  assert.equal(s.siteId, 'clinic');
  assert.ok(s.items.length >= 4, 'at least 4 doctor cards');
  const reyes = s.items.find((i) => /Reyes/.test(i.text));
  assert.equal(reyes.attrs.$, 120);
  assert.equal(reyes.attrs['★'], 4.7);
  assert.equal(reyes.attrs.time, 9.5);
  assert.equal(reyes.attrs['#'], 12);
  const lind = s.items.find((i) => /Lind/.test(i.text));
  assert.equal(lind.attrs.time, 14.25);
  const book = s.actions.find((a) => a.key === 'book');
  assert.ok(book && book.kind === 'click', 'book click action');
  assert.equal(book.selector, '[data-testid="book-reyes"]');
  assert.ok(reyes.actionKeys.includes('book'));
  assert.ok(s.actions.some((a) => a.key === 'specialty' && a.kind === 'select' && a.options.length === 5));
  assert.ok(s.actions.some((a) => a.key === 'appointment_date' && a.kind === 'type'));
  // executor: booking without a date surfaces an alert-ish status
  const rec = await page.evaluate(() => window.doorman.act('book'));
  assert.ok(rec.messagesAfter.some((m) => /choose a date/.test(m.text)));
});

// ---- (e) tools / modelContext ----------------------------------------------------
test('(e) tools() without and with document.modelContext', async () => {
  await gotoShop('#/');
  const t = await page.evaluate(() => window.doorman.tools().map((x) => ({ name: x.name, description: x.description, inputSchema: x.inputSchema })));
  assert.ok(t.length >= 1);
  assert.ok(t.some((x) => x.name === 'doorman_do' && x.inputSchema.properties.goal));
  assert.ok(t.some((x) => x.name === 'category' && x.inputSchema.properties.value.enum.includes('boots')));
  assert.ok(await page.evaluate(() => typeof document.modelContext === 'undefined'));

  const ctx = await browser.newContext();
  await ctx.addInitScript(() => {
    window.__registered = [];
    document.modelContext = { registerTool(tool) { window.__registered.push({ name: tool.name, hasSignal: !!tool.signal }); } };
  });
  const p2 = await ctx.newPage();
  await p2.goto(`${base}/shop/#/`, { waitUntil: 'load' });
  await p2.waitForFunction(() => window.__registered.length > 0);
  const reg = await p2.evaluate(() => window.__registered);
  assert.ok(reg.some((r) => r.name === 'doorman_do' && r.hasSignal));
  assert.ok(reg.some((r) => r.name === 'search_products'));
  const before = reg.length;
  await p2.evaluate(() => { location.hash = '#/product/road-racer'; });
  await p2.waitForFunction((n) => window.__registered.length > n && window.__registered.some((r) => r.name === 'add_to_cart'), before);
  await ctx.close();
});

// ---- (f) generality guard ----------------------------------------------------------
test('(f) doorman.js has no site vocabulary', () => {
  const src = fs.readFileSync(path.join(PUBLIC, 'doorman.js'), 'utf8');
  assert.doesNotMatch(src, /cart|checkout|product|price/i);
  assert.ok(src.split('\n').length < 600, 'under 600 lines');
});
