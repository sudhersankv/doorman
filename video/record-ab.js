'use strict';
/**
 * A/B recording: the same goal, the same fresh shop, two agents, each in its own isolated 1920x1080 Playwright
 * context with video. Nothing is scripted to win.
 *   A  baseline — an ordinary LLM browser agent (src/baseline/agent.js): reads the DOM, asks the LLM for one
 *      action per step, clicks. doorman.js is blocked on its page, so it sees the plain site.
 *   B  doorman  — the same goal delegated to window.doorman.do(goal); steps decided by Jev, LLM only on fallback.
 * Both are verified by the shop's own state (src/sim/verify.js). Measured results → video/raw/ab.json.
 *
 *   node video/record-ab.js [--base https://doorman-trailhead.fly.dev] [--goal "..."] [--goal-id <benchmark goal id>]
 * Needs real services (.env): the baseline agent needs the LLM.
 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
require('../src/lib/env');
const { makeDeps } = require('../src/lib');
const { runBaselineGoal, prepareFreshShopPage } = require('../src/baseline/agent');
const { verify } = require('../src/sim/verify');
const { toVerifySpec } = require('../src/sim/goals');
const { loadGoals } = require('../src/sim/run');

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const BASE = arg('--base', 'https://doorman-trailhead.fly.dev').replace(/\/$/, '');
const OUT = path.join(__dirname, 'raw');
fs.mkdirSync(OUT, { recursive: true });
const W = 1920, H = 1080;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const CURSOR_JS = fs.readFileSync(path.join(__dirname, 'record.js'), 'utf8').match(/const CURSOR_JS = `([\s\S]*?)`;/)[1];
// A small on-page log for the baseline so the viewer sees what the LLM agent is doing (the data is the agent's own steps).
const PANEL_JS = `(() => { if (document.getElementById('__bl_panel')) return; const p = document.createElement('div'); p.id = '__bl_panel';
  p.innerHTML = '<style>#__bl_panel{position:fixed;right:12px;bottom:12px;width:380px;z-index:2147483000;font:13px/1.4 system-ui,sans-serif;color:#e6e9ef;background:#171d28;border:1px solid #2a3242;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.35)}#__bl_panel header{padding:8px 10px;border-bottom:1px solid #2a3242;font-weight:600}#__bl_panel header b{color:#ff6b6b}#__bl_panel ol{list-style:none;margin:0;padding:4px 10px 8px;max-height:220px;overflow:auto;font-family:ui-monospace,Consolas,monospace;font-size:12px}#__bl_panel li{padding:2px 0;border-bottom:1px dashed #2a3242}#__bl_panel .t{color:#9aa4b6}#__bl_panel footer{padding:6px 10px;color:#9aa4b6;font-size:12px}</style><header><b>ordinary LLM agent</b> <span class="t">reads the DOM, asks the LLM each step</span></header><ol id="__bl_steps"></ol><footer id="__bl_foot">thinking…</footer>';
  document.body.appendChild(p); })();`;

async function newRecordedContext(browser, label) {
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, recordVideo: { dir: OUT, size: { width: W, height: H } }, colorScheme: 'dark', locale: 'en-US', timezoneId: 'America/Los_Angeles' });
  await ctx.addInitScript(CURSOR_JS);
  return ctx;
}
async function saveVideo(ctx, page, name) { const v = page.video(); await ctx.close(); const f = await v.path(); const dest = path.join(OUT, name); fs.renameSync(f, dest); return path.basename(dest); }

(async () => {
  const deps = await makeDeps(process.env);
  let goalText = arg('--goal', 'Add the Road Racer in size 9 to my cart.');
  let goal = null;
  try {
    const goals = await loadGoals({ deps });
    goal = arg('--goal-id') ? goals.find((g) => g.id === arg('--goal-id')) : goals.find((g) => g.text === goalText) || goals.find((g) => g.kind === 'add_to_cart' && g.possible && /road racer/i.test(g.text) && /\b9\b/.test(g.text));
    if (goal) goalText = goal.text;
  } catch (e) { log('goals not loaded, verifying by text only:', e.message); }
  if (!goal) goal = { id: 'adhoc', kind: 'add_to_cart', params: { productId: 'road-racer', size: 9 }, possible: true, flaw: null, text: goalText };
  log('goal:', goalText);

  const browser = await chromium.launch({ headless: true, args: ['--disable-infobars', '--hide-scrollbars'] });
  const ab = { base: BASE, goal: goalText, goalId: goal.id, recordedAt: new Date().toISOString(), model: deps.llm?.model || null };

  // ── A: baseline LLM browser agent ───────────────────────────────────────────────
  {
    const ctx = await newRecordedContext(browser, 'baseline');
    const page = await prepareFreshShopPage({ context: ctx, baseUrl: BASE, blockDoorman: true });
    await page.evaluate(PANEL_JS);
    await sleep(1500);
    await page.evaluate(() => { window.__bl_t0 = Date.now(); });
    const r = await runBaselineGoal({ goalText, page, llm: deps.llm, maxSteps: 12, log: deps.log, onStep: async (st) => {
      try { await page.evaluate((st) => { const ol = document.getElementById('__bl_steps'); if (!ol) return; const li = document.createElement('li'); li.innerHTML = `${st.i}. <b>${st.action}</b> ${st.ref != null ? '#' + st.ref : ''} ${st.value ? JSON.stringify(st.value) : ''} <span class="t">LLM ${(st.llmMs / 1000).toFixed(1)}s · ${st.result || ''}</span>`; ol.appendChild(li); ol.scrollTop = ol.scrollHeight; document.getElementById('__bl_foot').textContent = 'step ' + st.i + ' · ' + ((Date.now() - window.__bl_t0) / 1000).toFixed(1) + ' s'; }, { ...st, llmMs: st.llmMs || 0 }); } catch {}
    } });
    const state = await page.evaluate(() => window.shopState()).catch(() => ({ cart: [], orders: [], loggedIn: false, viewedOrders: [], lastError: null, events: [] }));
    const v = verify(toVerifySpec(goal), state, !!r.impossibleReported);
    try { await page.evaluate((txt) => { const f = document.getElementById('__bl_foot'); if (f) f.textContent = txt; }, `${v.success ? 'verified: goal reached' : 'verified: goal NOT reached'} · ${(r.ms / 1000).toFixed(1)} s · ${r.stepCount} steps · ${r.llmCalls} LLM calls`); } catch {}
    await sleep(2500);
    ab.baseline = { file: await saveVideo(ctx, page, 'ab-baseline.webm'), startOffsetS: 1.5, success: v.success, reason: v.reason, ms: r.ms, steps: r.stepCount, llmCalls: r.llmCalls, promptTokens: r.promptTokens, completionTokens: r.completionTokens, costUsd: r.llmCostUsd, costMeasured: true, stoppedBecause: r.stoppedBecause, actions: r.steps.map((s) => ({ action: s.action, ref: s.ref, value: s.value, llmMs: s.llmMs, result: s.result })), cart: state.cart };
    log('baseline:', JSON.stringify({ success: v.success, ms: r.ms, steps: r.stepCount, llmCalls: r.llmCalls, costUsd: r.llmCostUsd }));
  }

  // ── B: doorman ─────────────────────────────────────────────────────────────────
  {
    const ctx = await newRecordedContext(browser, 'doorman');
    const page = await prepareFreshShopPage({ context: ctx, baseUrl: BASE, blockDoorman: false });
    await page.waitForFunction(() => window.doorman && typeof window.doorman.do === 'function' && document.getElementById('doorman-hud'), null, { timeout: 15000 });
    await sleep(1500);
    const r = await page.evaluate(async (goal) => {
      const foot = document.querySelector('#doorman-foot'), list = document.querySelector('#doorman-steps'); const input = document.querySelector('#doorman-goal');
      if (input) input.value = goal; if (list) list.innerHTML = ''; if (foot) foot.textContent = 'running…';
      const t0 = performance.now();
      const res = await window.doorman.do(goal, { autoConfirm: true, maxSteps: 8 });
      const steps = (res.steps || []).map((s) => ({ action: s.action, tier: s.tier, confidence: s.confidence, outcome: s.outcome }));
      return { done: !!res.done, impossible: !!res.impossible, failureReason: res.failureReason || null, ms: Math.round(performance.now() - t0), steps, tierCounts: res.tierCounts || {}, visitId: res.visitId || null };
    }, goalText);
    const state = await page.evaluate(() => window.shopState());
    const v = verify(toVerifySpec(goal), state, !!r.impossible);
    const tc = r.tierCounts; const llmCalls = tc.T2_llm || 0, jevCalls = (tc.T1_jev || 0) + (tc.T2_llm || 0);
    const { PRICES } = require('../src/lib/llm'); const [pi, po] = PRICES[deps.llm?.model] || [1, 5];
    const costUsdEstimate = jevCalls * 1500 * 0.042 / 1e6 + llmCalls * (2000 * pi + 150 * po) / 1e6;
    try { await page.evaluate((txt) => { const f = document.querySelector('#doorman-foot'); if (f) f.textContent = txt; }, `${v.success ? 'verified: goal reached' : 'verified: goal NOT reached'} · ${(r.ms / 1000).toFixed(1)} s · ${r.steps.length} steps · ${llmCalls} LLM calls · ${jevCalls} Jev calls`); } catch {}
    await sleep(2500);
    ab.doorman = { file: await saveVideo(ctx, page, 'ab-doorman.webm'), startOffsetS: 1.5, success: v.success, reason: v.reason, ms: r.ms, steps: r.steps.length, llmCalls, jevCalls, costUsdEstimate, costEstimated: true, tierCounts: tc, tiers: r.steps.map((s) => s.tier), actions: r.steps.map((s) => s.action), visitId: r.visitId, cart: state.cart };
    log('doorman:', JSON.stringify({ success: v.success, ms: r.ms, steps: r.steps.length, llmCalls, jevCalls, costUsdEstimate }));
  }

  await browser.close();
  fs.writeFileSync(path.join(OUT, 'ab.json'), JSON.stringify(ab, null, 2));
  log('done →', path.join(OUT, 'ab.json'));
})().catch((e) => { console.error(e); process.exit(1); });
