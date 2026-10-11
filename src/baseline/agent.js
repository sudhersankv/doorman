'use strict';
/**
 * BASELINE: an ordinary LLM-driven browser agent that does NOT use Doorman. It observes the raw DOM (accessible
 * names, roles, values), asks a general-purpose LLM for one action per step, executes it with Playwright and loops.
 * Used for an honest A/B comparison against Doorman on the same site and goals (src/baseline/compare.js).
 *
 * The caller owns the Playwright `page`. Because a route must be installed BEFORE navigation, the caller calls
 * `prepareBaselinePage(page)` (blocks `** /doorman.js`) and then navigates — or uses `prepareFreshShopPage(...)`,
 * the benchmark glue that opens a page, blocks doorman.js, navigates to the shop and resets its state.
 *
 * runBaselineGoal({ goalText, page, llm, maxSteps, stepTimeoutMs, onStep, log }) ->
 *   { done, impossibleReported, steps, stepCount, llmCalls, promptTokens, completionTokens, llmCostUsd, ms, stoppedBecause }
 * The agent itself is generic: it knows nothing about the site.
 */
const { parseJson } = require('../lib/llm');

const MAX_ELEMENTS = 80, MAX_ITEMS = 40, HISTORY = 6, MAX_PARSE_FAILURES = 2;

const SYSTEM = `You are a browser agent. You are given a goal, the recent history of your actions, and an observation of the current
web page: URL, title, headings, any alerts or status messages, a numbered list of interactive elements, and a list of visible
item-like text blocks. Choose exactly ONE next action. Reply with a single JSON object and nothing else:
{"thought": "<brief reasoning>", "action": "click"|"fill"|"select"|"press"|"done"|"impossible", "ref": <element number>, "value": "<text / option value for fill|select, key for press (default Enter)>"}
Rules: "ref" must be a number from the element list. Use "select" for <select> elements (value = option value or label).
Use "fill" to type into inputs; follow with "press" Enter on the same ref to submit a search form if there is no submit button.
Reply "done" only when the goal is clearly achieved on the page (e.g. a confirmation message). Reply "impossible" when the site
cannot satisfy the goal (item does not exist, out of stock, validation rejects the only valid input, etc.). Do not repeat an
action that already failed with the same inputs.`;

/** Install the doorman.js route block on a page. Must run BEFORE the page navigates. */
async function prepareBaselinePage(page) {
  await page.route('**/doorman.js', (r) => r.abort());
}

/**
 * Benchmark glue: new page in `context`, block doorman.js (unless `blockDoorman:false`), open the shop and reset it.
 * Both A/B variants can start from this identical state. Returns the page.
 * @param {{ context:import('playwright').BrowserContext, baseUrl:string, blockDoorman?:boolean }} args
 */
async function prepareFreshShopPage({ context, baseUrl, blockDoorman = true }) {
  const base = String(baseUrl).replace(/\/+$/, '');
  const page = await context.newPage();
  if (blockDoorman) await prepareBaselinePage(page);
  await page.goto(`${base}/shop/#/`, { waitUntil: 'load', timeout: 20000 });
  await page.waitForFunction(() => typeof window.shopReset === 'function', null, { timeout: 15000 });
  await page.evaluate(() => { try { localStorage.clear(); } catch {} window.shopReset(); });
  await page.waitForTimeout(100);
  return page;
}

/**
 * Build a compact text observation of the page and tag interactive elements with `data-bl-ref="N"`.
 * @returns {Promise<{ url:string, title:string, headings:string[], messages:string[], elements:object[], items:string[], text:string }>}
 */
async function buildObservation(page) {
  const obs = await page.evaluate(({ MAX_ELEMENTS, MAX_ITEMS }) => {
    const clip = (s, n = 80) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
    const visible = (el) => { if (!el.getClientRects().length) return false; const cs = getComputedStyle(el); return cs.visibility !== 'hidden' && cs.display !== 'none'; };
    const labelOf = (el) => {
      if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
      const by = el.getAttribute('aria-labelledby'); if (by) { const t = by.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ').trim(); if (t) return t; }
      if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l) return l.textContent; }
      const wrap = el.closest('label'); if (wrap) { const t = Array.from(wrap.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' ').trim(); if (t) return t; }
      return el.textContent || el.getAttribute('title') || el.getAttribute('placeholder') || el.value || el.getAttribute('name') || '';
    };
    document.querySelectorAll('[data-bl-ref]').forEach((el) => el.removeAttribute('data-bl-ref'));
    const headings = Array.from(document.querySelectorAll('h1,h2,h3')).filter(visible).map((h) => clip(h.textContent)).filter(Boolean).slice(0, 12);
    const messages = Array.from(document.querySelectorAll('[role="alert"],[role="status"],[aria-live]:not(main),.error,.ok,output')).filter(visible).map((m) => clip(m.textContent, 160)).filter(Boolean);
    const sel = 'a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=link],[role=textbox],[role=combobox],[role=checkbox],[tabindex]:not([tabindex="-1"])';
    const elements = []; let n = 0;
    for (const el of document.querySelectorAll(sel)) {
      if (elements.length >= MAX_ELEMENTS || !visible(el) || el.disabled) continue;
      if (elements.some((e) => e.node === el)) continue;
      const tag = el.tagName.toLowerCase();
      const type = tag === 'input' ? (el.type || 'text') : (el.getAttribute('role') || '');
      const kind = tag === 'a' ? 'link' : tag === 'button' || type === 'button' || type === 'submit' ? 'button' : tag === 'select' ? 'select' : tag === 'input' || tag === 'textarea' ? 'input' : type || tag;
      const e = { ref: ++n, kind, name: clip(labelOf(el), 60), node: el };
      if (tag === 'input' || tag === 'textarea') { e.type = type; if (el.placeholder) e.placeholder = clip(el.placeholder, 40); e.value = clip(el.value, 40); if (type === 'checkbox' || type === 'radio') e.checked = !!el.checked; }
      if (tag === 'select') { e.value = el.value; e.options = Array.from(el.options).slice(0, 30).map((o) => ({ value: o.value, label: clip(o.textContent, 40) })); }
      if (tag === 'a') e.href = clip(el.getAttribute('href'), 60);
      el.setAttribute('data-bl-ref', String(n));
      elements.push(e);
    }
    // repeated structures (cards/rows/list entries) whose text carries a number: product cards, order rows, etc.
    const items = []; const seen = new Set();
    for (const el of document.querySelectorAll('article,li,tr,[class*=card],[class*=item],[class*=row]')) {
      if (items.length >= MAX_ITEMS || !visible(el)) continue;
      const sibs = el.parentElement ? Array.from(el.parentElement.children).filter((c) => c.tagName === el.tagName && c.className === el.className) : [];
      if (sibs.length < 2) continue;
      if (el.querySelector('article,li,tr,[class*=card]') && el.textContent.length > 300) continue; // container, not a leaf item
      const t = clip(el.innerText, 120); if (!t || !/\d/.test(t) || seen.has(t)) continue;
      seen.add(t); items.push(t);
    }
    return { url: location.href, title: document.title, headings, messages, items, elements: elements.map(({ node, ...e }) => e) };
  }, { MAX_ELEMENTS, MAX_ITEMS });
  obs.text = formatObservation(obs);
  return obs;
}

/** Render the observation object as the text the model sees. */
function formatObservation(o) {
  const q = (s) => JSON.stringify(String(s ?? ''));
  const line = (e) => {
    let s = `[${e.ref}] ${e.kind}${e.type && e.type !== 'text' ? `(${e.type})` : ''} ${q(e.name)}`;
    if (e.placeholder) s += ` placeholder=${q(e.placeholder)}`;
    if (e.value != null && e.kind !== 'select') s += ` value=${q(e.value)}`;
    if (e.checked != null) s += ` checked=${e.checked}`;
    if (e.href) s += ` href=${e.href}`;
    if (e.options) s += ` selected=${q(e.value)} options: ${e.options.map((x) => `${x.value}=${x.label}`).join(' | ')}`;
    return s;
  };
  return [
    `URL: ${o.url}`, `Title: ${o.title}`,
    o.headings.length ? `Headings: ${o.headings.join(' / ')}` : '',
    o.messages.length ? `Messages: ${o.messages.map((m) => `"${m}"`).join('; ')}` : 'Messages: (none)',
    `Interactive elements (${o.elements.length}):`, ...o.elements.map(line),
    o.items.length ? `Visible items (${o.items.length}):` : '', ...o.items.map((t) => `- ${t}`),
  ].filter(Boolean).join('\n');
}

function buildMessages({ goalText, history, obs }) {
  const past = history.slice(-HISTORY).map((h, i) => `${history.length - Math.min(history.length, HISTORY) + i + 1}. ${h.action}${h.ref != null ? ` ref=${h.ref}` : ''}${h.value != null ? ` value=${JSON.stringify(h.value)}` : ''} (${h.target || ''}) -> ${h.result}; then: ${h.after}`);
  const user = [`GOAL: ${goalText}`, '', past.length ? `HISTORY (last ${past.length}):\n${past.join('\n')}` : 'HISTORY: (none yet)', '', `OBSERVATION:\n${obs.text}`, '', 'Reply with the JSON action object.'].join('\n');
  return [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }];
}

/** Execute one parsed action on the page. Returns a short result string. */
async function execute(page, act, { stepTimeoutMs }) {
  const loc = page.locator(`[data-bl-ref="${Number(act.ref)}"]`).first();
  if (!(await loc.count())) return `error: no element with ref ${act.ref}`;
  const timeout = Math.min(stepTimeoutMs, 10000);
  if (act.action === 'click') await loc.click({ timeout });
  else if (act.action === 'fill') await loc.fill(String(act.value ?? ''), { timeout });
  else if (act.action === 'select') {
    const v = String(act.value ?? '');
    try { await loc.selectOption({ value: v }, { timeout }); } catch { await loc.selectOption({ label: v }, { timeout }); }
  } else if (act.action === 'press') await loc.press(String(act.value || 'Enter'), { timeout });
  else return `error: unknown action ${act.action}`;
  await page.waitForTimeout(400);
  await page.waitForLoadState('networkidle', { timeout: 1500 }).catch(() => {});
  return 'ok';
}

function summarizeAfter(obs) {
  return [obs.url.replace(/^https?:\/\/[^/]+/, ''), obs.messages[0] ? `msg "${obs.messages[0]}"` : ''].filter(Boolean).join(' ');
}

/**
 * Run one goal with the baseline agent on an already-prepared page.
 * @param {{ goalText:string, page:import('playwright').Page, llm:{chat:Function}, maxSteps?:number, stepTimeoutMs?:number, onStep?:Function, log?:Function }} args
 */
async function runBaselineGoal({ goalText, page, llm, maxSteps = 12, stepTimeoutMs = 20000, onStep, log = () => {} }) {
  const t0 = Date.now();
  const steps = [], history = [];
  let done = false, impossibleReported = false, stoppedBecause = 'max_steps', parseFailures = 0;
  let llmCalls = 0, promptTokens = 0, completionTokens = 0, llmCostUsd = 0;
  for (let i = 0; i < maxSteps; i++) {
    const s0 = Date.now();
    const obs = await buildObservation(page);
    const step = { i: i + 1, action: null, ref: null, value: null, thought: null, result: null, llmMs: 0, usage: null, costUsd: 0, wallMs: 0 };
    let r;
    try { r = await llm.chat(buildMessages({ goalText, history, obs }), { json: true, tag: 'baseline', maxTokens: 400 }); }
    catch (e) { step.result = `error: llm ${e.message}`; step.wallMs = Date.now() - s0; steps.push(step); stoppedBecause = 'error'; log('baseline-error', { error: e.message }); break; }
    llmCalls++; step.llmMs = r.ms || 0; step.usage = r.usage || null; step.costUsd = r.costUsd || 0;
    promptTokens += r.usage?.prompt_tokens || 0; completionTokens += r.usage?.completion_tokens || 0; llmCostUsd += r.costUsd || 0;
    const act = parseJson(r.text);
    if (!act || typeof act !== 'object' || !act.action) {
      parseFailures++; step.result = 'error: unparseable llm output'; step.wallMs = Date.now() - s0; steps.push(step);
      log('baseline-parse-fail', { i, text: String(r.text).slice(0, 120) });
      if (parseFailures >= MAX_PARSE_FAILURES) { stoppedBecause = 'parse_failures'; break; }
      continue;
    }
    parseFailures = 0;
    Object.assign(step, { action: act.action, ref: act.ref ?? null, value: act.value ?? null, thought: act.thought ? String(act.thought).slice(0, 200) : null });
    if (act.action === 'done' || act.action === 'impossible') {
      done = act.action === 'done'; impossibleReported = act.action === 'impossible'; stoppedBecause = act.action;
      step.result = 'ok'; step.wallMs = Date.now() - s0; steps.push(step); if (onStep) await onStep(step, obs); break;
    }
    const target = obs.elements.find((e) => e.ref === Number(act.ref));
    let timer;
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`step timeout after ${stepTimeoutMs} ms`)), stepTimeoutMs); });
    try { step.result = await Promise.race([execute(page, act, { stepTimeoutMs }), timeout]); }
    catch (e) { step.result = `error: ${String(e.message).split('\n')[0].slice(0, 120)}`; }
    finally { clearTimeout(timer); }
    const after = await buildObservation(page).catch(() => obs);
    history.push({ action: act.action, ref: act.ref, value: act.value, target: target ? `${target.kind} "${target.name}"` : 'no such ref', result: step.result, after: summarizeAfter(after) });
    step.wallMs = Date.now() - s0; steps.push(step);
    log('baseline-step', { i: step.i, action: step.action, ref: step.ref, value: step.value, result: step.result, llmMs: step.llmMs });
    if (onStep) await onStep(step, after);
  }
  return { done, impossibleReported, steps, stepCount: steps.length, llmCalls, promptTokens, completionTokens, llmCostUsd, ms: Date.now() - t0, stoppedBecause };
}

module.exports = { runBaselineGoal, prepareBaselinePage, prepareFreshShopPage, buildObservation, formatObservation, SYSTEM };
