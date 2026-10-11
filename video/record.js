'use strict';
/**
 * Records the demo scenes with an isolated Playwright Chromium (1920x1080, fresh profile, no personal session).
 * Every scene is real application behaviour against BASE (default: the Fly deployment). Nothing is scripted
 * to succeed: results (done/failed, ms, steps, tiers) are measured and written to video/raw/scenes.json,
 * and the edit only captions what is in that file.
 *
 *   node video/record.js                      # records against https://doorman-trailhead.fly.dev
 *   node video/record.js --base http://localhost:3000
 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const BASE = arg('--base', 'https://doorman-trailhead.fly.dev').replace(/\/$/, '');
const OUT = path.join(__dirname, 'raw');
const ONLY = arg('--only', '') ? arg('--only').split(',') : null; // re-record a subset; others are kept in scenes.json
fs.mkdirSync(OUT, { recursive: true });
const W = 1920, H = 1080;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const scenes = (() => { try { return ONLY ? JSON.parse(fs.readFileSync(path.join(OUT, 'scenes.json'), 'utf8')).scenes.filter((x) => !ONLY.includes(x.name)) : []; } catch { return []; } })();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// A visible cursor + click ripple, injected into every page so Playwright's mouse shows up in the recording.
const CURSOR_JS = `(() => {
  if (window.__dmCursor) return; window.__dmCursor = true;
  const style = document.createElement('style');
  style.textContent = '#__dm_cur{position:fixed;left:0;top:0;width:22px;height:22px;pointer-events:none;z-index:2147483647;transform:translate(-3px,-2px);filter:drop-shadow(0 2px 4px rgba(0,0,0,.5))}#__dm_rip{position:fixed;width:44px;height:44px;margin:-22px 0 0 -22px;border:2px solid #00ed64;border-radius:50%;pointer-events:none;z-index:2147483646;opacity:0}@keyframes __dmr{0%{transform:scale(.3);opacity:.9}100%{transform:scale(1.4);opacity:0}}';
  document.documentElement.appendChild(style);
  const cur = document.createElement('div'); cur.id = '__dm_cur';
  cur.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M4 2l16 9-7 1.5L9.5 20z" fill="#fff" stroke="#06101a" stroke-width="1.5" stroke-linejoin="round"/></svg>';
  const rip = document.createElement('div'); rip.id = '__dm_rip';
  const mount = () => { document.body.appendChild(cur); document.body.appendChild(rip); };
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
  window.addEventListener('mousemove', (e) => { cur.style.left = e.clientX + 'px'; cur.style.top = e.clientY + 'px'; }, true);
  window.addEventListener('mousedown', (e) => { rip.style.left = e.clientX + 'px'; rip.style.top = e.clientY + 'px'; rip.style.animation = 'none'; void rip.offsetWidth; rip.style.animation = '__dmr .5s ease-out'; }, true);
})();`;

const want = (name) => !ONLY || ONLY.includes(name);
async function newScene(browser, name) {
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, recordVideo: { dir: OUT, size: { width: W, height: H } }, colorScheme: 'dark', locale: 'en-US', timezoneId: 'America/Los_Angeles' });
  await ctx.addInitScript(CURSOR_JS);
  const page = await ctx.newPage();
  const t0 = Date.now();
  const scene = { name, startedAt: new Date().toISOString(), marks: [] };
  const mark = (label, extra = {}) => { scene.marks.push({ label, t: (Date.now() - t0) / 1000, ...extra }); log(name, '·', label, JSON.stringify(extra)); };
  const finish = async (result = {}) => {
    scene.durationS = (Date.now() - t0) / 1000;
    Object.assign(scene, result);
    const video = page.video();
    await ctx.close();
    const file = await video.path();
    const dest = path.join(OUT, `${name}.webm`);
    fs.renameSync(file, dest);
    scene.file = path.basename(dest);
    scenes.push(scene); scenes.sort((a, b) => a.name.localeCompare(b.name));
    fs.writeFileSync(path.join(OUT, 'scenes.json'), JSON.stringify({ base: BASE, recordedAt: new Date().toISOString(), scenes }, null, 2));
    log(name, 'saved', scene.file, scene.durationS.toFixed(1) + 's');
  };
  return { ctx, page, mark, finish };
}

async function glide(page, x, y, steps = 25) { await page.mouse.move(x, y, { steps }); }
async function smoothScroll(page, to, ms = 1500) {
  await page.evaluate(({ to, ms }) => new Promise((res) => { const from = window.scrollY, t0 = performance.now(); const ease = (t) => 1 - Math.pow(1 - t, 3); const f = (now) => { const p = Math.min(1, (now - t0) / ms); window.scrollTo(0, from + (to - from) * ease(p)); if (p < 1) requestAnimationFrame(f); else res(); }; requestAnimationFrame(f); }), { to, ms });
}
async function typeInHud(page, goal) {
  const input = page.locator('#doorman-goal');
  const box = await input.boundingBox();
  await glide(page, box.x + 40, box.y + box.height / 2, 30);
  await page.mouse.click(box.x + 40, box.y + box.height / 2);
  await sleep(300);
  await input.fill('');
  await page.keyboard.type(goal, { delay: 28 });
  await sleep(500);
}
async function runGoal(page, goal, opts = {}) {
  // Runs through window.doorman.do so the result object is captured; the HUD shows the live steps via doorman:step events.
  return page.evaluate(async ({ goal, opts }) => {
    const foot = document.querySelector('#doorman-foot'), list = document.querySelector('#doorman-steps');
    if (list) list.innerHTML = ''; if (foot) foot.textContent = 'running…';
    const t0 = performance.now();
    const r = await window.doorman.do(goal, { autoConfirm: true, ...opts });
    const steps = (r.steps || []).map((s) => ({ action: s.action, tier: s.tier, confidence: s.confidence, outcome: s.outcome }));
    const tc = r.tierCounts || {};
    if (foot) foot.textContent = (r.done ? 'done' : r.impossible ? 'not possible on this site' : 'stopped') + ' · ' + Math.round(performance.now() - t0) + ' ms · ' + steps.length + ' steps · ' + Object.entries(tc).map(([k, v]) => k.replace(/^T\d_/, '') + ' ' + v).join(', ');
    let cart = null; try { cart = (JSON.parse(localStorage.getItem('trailhead_state_v1')) || {}).cart || null; } catch {}
    return { done: !!r.done, impossible: !!r.impossible, failureReason: r.failureReason || null, error: r.error || null, ms: Math.round(performance.now() - t0), steps: steps.length, tiers: steps.map((s) => s.tier), confidences: steps.map((s) => s.confidence), actions: steps.map((s) => s.action), visitId: r.visitId || null, tierCounts: tc, cart };
  }, { goal, opts });
}
async function clearShopState(page) { await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (!/doorman/i.test(k)) localStorage.removeItem(k); }); await page.reload({ waitUntil: 'networkidle' }); await page.waitForSelector('#doorman-hud'); }

(async () => {
  log('recording against', BASE);
  const browser = await chromium.launch({ headless: true, args: ['--disable-infobars', '--hide-scrollbars', '--force-device-scale-factor=1'] });

  // ── scene 1: the site, as a human sees it ─────────────────────────────────────────
  if (want('01-shop')) {
    const s = await newScene(browser, '01-shop');
    await s.page.goto(BASE + '/shop/', { waitUntil: 'networkidle' });
    await s.page.waitForSelector('#doorman-hud');
    await sleep(800); s.mark('loaded');
    await glide(s.page, 700, 420, 40); await sleep(400);
    await smoothScroll(s.page, 700, 1800); s.mark('scrolled');
    await glide(s.page, 1000, 600, 40); await sleep(600);
    await smoothScroll(s.page, 0, 1200); await sleep(600);
    await s.finish();
  }

  // ── scene 2: a vague goal, delegated in natural language (may fail — recorded as it happens) ──
  if (want('02-vague-goal')) {
    const s = await newScene(browser, '02-vague-goal');
    await s.page.goto(BASE + '/shop/', { waitUntil: 'networkidle' });
    await clearShopState(s.page);
    await sleep(600); s.mark('loaded');
    const goal = 'Find running shoes under $80 and add an appropriate pair to my cart.';
    await typeInHud(s.page, goal); s.mark('typed');
    const r = await runGoal(s.page, goal); s.mark('result', { done: r.done, ms: r.ms, steps: r.steps });
    await sleep(2500);
    await s.finish({ goal, result: r });
  }

  // ── scene 3: a specific goal (fresh cart) ─────────────────────────────────────────
  if (want('03-specific-goal')) {
    const s = await newScene(browser, '03-specific-goal');
    await s.page.goto(BASE + '/shop/', { waitUntil: 'networkidle' });
    await clearShopState(s.page);
    await sleep(600); s.mark('loaded');
    const goal = 'Add the Road Racer in size 9 to my cart.';
    await typeInHud(s.page, goal); s.mark('typed');
    const r = await runGoal(s.page, goal); s.mark('result', { done: r.done, ms: r.ms, steps: r.steps, tiers: r.tiers });
    await sleep(1500);
    // show the cart
    const cart = s.page.locator('a[href="#/cart"], [aria-label="Cart"], #cart-link').first();
    if (await cart.count()) { const b = await cart.boundingBox(); if (b) { await glide(s.page, b.x + b.width / 2, b.y + b.height / 2, 30); await s.page.mouse.click(b.x + b.width / 2, b.y + b.height / 2); s.mark('cart-opened'); await sleep(2000); } }
    await s.finish({ goal, result: r });
  }

  // ── scene 4: the same goal again on a fresh cart — does memory (recipe) kick in? ───
  if (want('04-memory')) {
    const s = await newScene(browser, '04-memory');
    await s.page.goto(BASE + '/shop/', { waitUntil: 'networkidle' });
    await clearShopState(s.page);
    await sleep(600); s.mark('loaded');
    const goal = 'Add the Road Racer in size 9 to my cart.';
    await typeInHud(s.page, goal); s.mark('typed');
    const r = await runGoal(s.page, goal); s.mark('result', { done: r.done, ms: r.ms, steps: r.steps, tiers: r.tiers });
    await sleep(2500);
    await s.finish({ goal, result: r });
  }

  // ── scene 5: owner analytics ──────────────────────────────────────────────────────
  if (want('05-dashboard')) {
    const s = await newScene(browser, '05-dashboard');
    await s.page.goto(BASE + '/dashboard/', { waitUntil: 'networkidle' });
    await s.page.waitForSelector('.tile');
    await sleep(1200); s.mark('loaded');
    const a = await s.page.evaluate(() => fetch('/api/analytics?site=trailhead').then((r) => r.json()));
    const total = await s.page.evaluate(() => document.documentElement.scrollHeight);
    const stops = ['section:nth-of-type(2)', 'section:nth-of-type(3)', 'section:nth-of-type(5)', 'section:nth-of-type(7)', 'section:nth-of-type(9)'];
    for (const sel of stops) {
      const y = await s.page.evaluate((sel) => { const el = document.querySelector(sel); return el ? el.getBoundingClientRect().top + window.scrollY - 24 : null; }, sel);
      if (y == null) continue;
      await smoothScroll(s.page, Math.min(y, total - H), 1400); s.mark('at ' + sel); await sleep(2600);
    }
    await s.finish({ analytics: { visits: a.visits, headline: a.headline, tiers: { steps: a.tiers.steps, shares: a.tiers.shares }, unmet: a.unmet.length, costEstimateUsd: a.cost.totalUsd } });
  }

  // ── scene 6: harness evolution ────────────────────────────────────────────────────
  if (want('06-evolution')) {
    const s = await newScene(browser, '06-evolution');
    await s.page.goto(BASE + '/evolution/', { waitUntil: 'networkidle' });
    await sleep(1500); s.mark('loaded');
    const evo = await s.page.evaluate(() => fetch('/api/evolution?site=trailhead').then((r) => r.json()).catch(() => null));
    const total = await s.page.evaluate(() => document.documentElement.scrollHeight);
    const steps = 5;
    for (let i = 1; i <= steps; i++) { await smoothScroll(s.page, Math.min(total - H, (total - H) * (i / steps)), 1600); s.mark('scroll ' + i); await sleep(2800); }
    await s.finish({ evolution: evo && evo.versions ? evo.versions.map((v) => ({ version: v.version, active: v.active, verdict: v.verdict, patch: v.patch, heldout: v.eval && v.eval.heldout && { successPossible: v.eval.heldout.successPossible, medianMs: v.eval.heldout.medianMs, llmFallbackRate: v.eval.heldout.llmFallbackRate, n: v.eval.heldout.n } })) : null });
  }

  await browser.close();
  log('done →', path.join(OUT, 'scenes.json'));
})().catch((e) => { console.error(e); process.exit(1); });
