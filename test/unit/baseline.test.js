'use strict';
// Offline tests for the baseline (non-Doorman) browser agent: observation builder, fake-LLM loop, parse-failure stop.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { chromium } = require('playwright');
const { makeFakeLlm } = require('../../src/lib/llm');
const { runBaselineGoal, buildObservation, prepareBaselinePage } = require('../../src/baseline/agent');
const { estimateDoormanCost, aggregateSide } = require('../../src/baseline/compare');

const FIXTURE = `<!doctype html><html><head><title>Fixture Store</title></head><body>
<h1>Widgets</h1>
<form id="f" role="search"><input id="q" type="search" aria-label="Search things" placeholder="Search…"><button type="submit">Search</button></form>
<a href="#/item/blue" aria-label="View Blue Widget">View</a>
<label>Size <select id="size"><option value="">Choose</option><option value="9">9</option><option value="10">10 — out of stock</option></select></label>
<button id="add">Add to cart</button>
<div id="msg" role="status"></div>
<p role="alert" id="al" style="display:none">hidden alert</p>
<a href="#/x" style="display:none">hidden link</a>
<div class="grid"><article class="card"><h2>Blue Widget</h2><span>$12.00</span></article><article class="card"><h2>Red Widget</h2><span>$15.00</span></article></div>
<script src="/doorman.js"></script>
<script>document.getElementById('add').onclick=()=>{document.getElementById('msg').textContent='Added to cart.';window.added=(window.added||0)+1};</script>
</body></html>`;

let server, base, browser;
before(async () => {
  server = http.createServer((req, res) => {
    if (req.url.startsWith('/doorman.js')) { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end('window.doormanLoaded=true;'); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(FIXTURE);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
});
after(async () => { if (browser) await browser.close(); if (server) server.close(); });

async function openFixture() {
  const page = await browser.newPage();
  await prepareBaselinePage(page);
  await page.goto(`${base}/`, { waitUntil: 'load' });
  return page;
}
const refOf = (text, re) => { const m = new RegExp(`\\[(\\d+)\\] [^\\n]*${re}`).exec(text); return m ? Number(m[1]) : null; };
const lastUser = (messages) => messages[messages.length - 1].content;

test('(a) observation: numbered refs, names, select options, messages, items; doorman.js blocked', async () => {
  const page = await openFixture();
  const o = await buildObservation(page);
  assert.equal(await page.evaluate(() => !!window.doormanLoaded), false, 'doorman.js must be blocked');
  assert.equal(o.title, 'Fixture Store'); assert.deepEqual(o.headings, ['Widgets', 'Blue Widget', 'Red Widget']);
  assert.deepEqual(o.elements.map((e) => e.ref), [1, 2, 3, 4, 5]); // hidden link excluded
  const by = (name) => o.elements.find((e) => e.name === name);
  assert.equal(by('Search things').kind, 'input'); assert.equal(by('Search things').type, 'search'); assert.equal(by('Search things').placeholder, 'Search…');
  assert.equal(by('Search').kind, 'button'); assert.equal(by('View Blue Widget').kind, 'link'); assert.equal(by('View Blue Widget').href, '#/item/blue');
  assert.equal(by('Size').kind, 'select'); assert.deepEqual(by('Size').options.map((x) => x.value), ['', '9', '10']);
  assert.equal(by('Add to cart').kind, 'button');
  assert.deepEqual(o.messages, []); // empty status + hidden alert are dropped
  assert.ok(o.items.some((t) => /Blue Widget \$12\.00/.test(t)) && o.items.some((t) => /Red Widget/.test(t)), JSON.stringify(o.items));
  assert.equal(await page.getAttribute('#add', 'data-bl-ref'), String(by('Add to cart').ref));
  assert.match(o.text, /\[\d+\] select "Size" selected="" options: =Choose \| 9=9 \| 10=10 — out of stock/);
  await page.evaluate(() => { document.getElementById('msg').textContent = 'Added to cart.'; });
  const o2 = await buildObservation(page);
  assert.deepEqual(o2.messages, ['Added to cart.']);
  await page.close();
});

test('(b) runBaselineGoal: fake LLM clicks "Add to cart" then reports done', async () => {
  const page = await openFixture();
  const prompts = [];
  const llm = makeFakeLlm({ baseline: (messages) => {
    const u = lastUser(messages); prompts.push(u);
    if (/Messages: "Added to cart\."/.test(u)) return { thought: 'confirmed', action: 'done' };
    return { thought: 'add it', action: 'click', ref: refOf(u, 'button "Add to cart"') };
  } });
  const seen = [];
  const r = await runBaselineGoal({ goalText: 'put the blue widget in the cart', page, llm, maxSteps: 5, onStep: (s) => seen.push(s.action) });
  assert.equal(r.done, true); assert.equal(r.impossibleReported, false); assert.equal(r.stoppedBecause, 'done');
  assert.equal(r.llmCalls, 2); assert.equal(r.stepCount, 2); assert.equal(r.steps.length, 2);
  assert.equal(r.steps[0].action, 'click'); assert.equal(r.steps[0].result, 'ok'); assert.equal(r.steps[1].action, 'done');
  assert.equal(r.llmCostUsd, 0); assert.equal(r.promptTokens, 200); assert.equal(r.completionTokens, 100);
  assert.ok(r.ms >= 0 && r.steps[0].wallMs >= 400);
  assert.equal(await page.evaluate(() => window.added), 1);
  assert.deepEqual(seen, ['click', 'done']);
  assert.match(prompts[0], /GOAL: put the blue widget in the cart/); assert.match(prompts[0], /HISTORY: \(none yet\)/);
  assert.match(prompts[1], /HISTORY \(last 1\):\n1\. click ref=\d+ \(button "Add to cart"\) -> ok/);
  await page.close();
});

test('(c) parse failures: stops after 2 consecutive unparseable replies; a good reply resets the counter', async () => {
  const page = await openFixture();
  const r = await runBaselineGoal({ goalText: 'anything', page, llm: makeFakeLlm({ baseline: () => 'I am not JSON' }), maxSteps: 6 });
  assert.equal(r.stoppedBecause, 'parse_failures'); assert.equal(r.llmCalls, 2); assert.equal(r.stepCount, 2);
  assert.equal(r.done, false); assert.match(r.steps[0].result, /unparseable/);
  let n = 0;
  const llm = makeFakeLlm({ baseline: (messages) => (++n % 2 ? 'garbage' : { action: 'click', ref: refOf(lastUser(messages), 'button "Search"') }) });
  const r2 = await runBaselineGoal({ goalText: 'anything', page, llm, maxSteps: 4 });
  assert.equal(r2.stoppedBecause, 'max_steps'); assert.equal(r2.llmCalls, 4);
  assert.deepEqual(r2.steps.map((s) => s.action), [null, 'click', null, 'click']);
  await page.close();
});

test('(d) bad ref and unknown action are recorded as errors, loop continues', async () => {
  const page = await openFixture();
  let n = 0;
  const llm = makeFakeLlm({ baseline: () => [{ action: 'click', ref: 99 }, { action: 'fly', ref: 1 }, { action: 'impossible', thought: 'nope' }][n++] });
  const r = await runBaselineGoal({ goalText: 'anything', page, llm, maxSteps: 5 });
  assert.match(r.steps[0].result, /no element with ref 99/); assert.match(r.steps[1].result, /unknown action/);
  assert.equal(r.impossibleReported, true); assert.equal(r.stoppedBecause, 'impossible'); assert.equal(r.llmCalls, 3);
  await page.close();
});

test('(e) compare helpers: doorman cost estimate matches server.js formula; aggregate shape', () => {
  const e = estimateDoormanCost({ T1_recipe: 2, T1_jev: 3, T2_llm: 1 }, 'gpt-5-4-mini');
  assert.equal(e.jevCalls, 4); assert.equal(e.llmCalls, 1);
  assert.ok(Math.abs(e.jevUsd - 4 * 1500 * 0.042 / 1e6) < 1e-12);
  assert.ok(Math.abs(e.llmUsd - (2000 * 0.75 + 150 * 4.5) / 1e6) < 1e-12);
  const rows = [
    { possible: true, baseline: { success: true, ms: 100, steps: 2, llmCalls: 2, costUsd: 0.01 }, doorman: { success: true, ms: 50, steps: 3, llmCalls: 0, jevCalls: 3, costUsdEstimate: 0.0002 } },
    { possible: false, baseline: { success: false, ms: 300, steps: 4, llmCalls: 4, costUsd: 0.02 }, doorman: { success: true, ms: 70, steps: 2, llmCalls: 1, jevCalls: 2, costUsdEstimate: 0.002 } },
  ];
  const b = aggregateSide(rows, 'baseline'), d = aggregateSide(rows, 'doorman');
  assert.deepEqual(b, { successRate: 0.5, medianMs: 200, meanMs: 200, meanSteps: 3, totalLlmCalls: 6, totalCostUsd: 0.03, successPossible: 1, impossibleHandled: 0 });
  assert.equal(d.successRate, 1); assert.equal(d.totalJevCalls, 5); assert.equal(d.totalLlmCalls, 1); assert.equal(d.totalCostUsd, 0.0022);
});
