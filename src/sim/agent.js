'use strict';
/**
 * Runs one benchmark goal through the real stack: Playwright opens the shop, resets its state, hands the goal to
 * `window.doorman.do(...)`, then the objective verifier reads `window.shopState()`.
 * runGoal({ goal, baseUrl, browser, deps?, maxSteps?, timeoutMs? }) ->
 *   { goalId, success, failureKind, reason, ms, steps, tierCounts, impossibleReported, visitId }
 */
const { verify } = require('./verify');
const { toVerifySpec } = require('./goals');

const DEFAULT_TIMEOUT_MS = 60000;

/**
 * @param {{ goal:object, baseUrl:string, browser:import('playwright').Browser, deps?:object, maxSteps?:number, timeoutMs?:number }} args
 */
async function runGoal({ goal, baseUrl, browser, deps, maxSteps = 8, timeoutMs = DEFAULT_TIMEOUT_MS, configVersion = null, noRecipes = false }) {
  const log = deps?.log || (() => {});
  const base = String(baseUrl).replace(/\/+$/, '');
  const context = await browser.newContext();
  const page = await context.newPage();
  const t0 = Date.now();
  let result = { ok: false, done: false, impossible: false, steps: 0, ms: 0, tierCounts: {}, visitId: null };
  let state = null, error = null;
  try {
    await page.goto(`${base}/shop/#/`, { waitUntil: 'load', timeout: 20000 });
    await page.waitForFunction(() => window.shopReset && window.doorman && typeof window.doorman.do === 'function', null, { timeout: 15000 });
    await page.evaluate(() => { try { localStorage.clear(); } catch {} window.shopReset(); });
    // view_order goals start logged out on purpose (planted flaw C): the agent must find the footer sign-in.
    await page.waitForTimeout(100);
    const run = page.evaluate(async ({ text, maxSteps, configVersion, noRecipes }) => {
      const r = await window.doorman.do(text, { autoConfirm: true, maxSteps, configVersion, noRecipes });
      return JSON.parse(JSON.stringify(r || {}));
    }, { text: goal.text, maxSteps, configVersion, noRecipes });
    let timer;
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`goal timeout after ${timeoutMs} ms`)), timeoutMs); });
    try { result = { ...result, ...(await Promise.race([run, timeout])) }; } finally { clearTimeout(timer); }
  } catch (e) {
    error = e; log('agent-error', { goalId: goal.id, error: e.message });
  }
  try { state = await page.evaluate(() => window.shopState()); } catch { state = { cart: [], orders: [], loggedIn: false, viewedOrders: [], lastError: null, events: [] }; }
  await context.close().catch(() => {});
  const v = verify(toVerifySpec(goal), state, !!result.impossible);
  const ms = Number(result.ms) || (Date.now() - t0);
  return {
    goalId: goal.id, kind: goal.kind, flaw: goal.flaw || null, possible: !!goal.possible, split: goal.split,
    success: !!v.success, failureKind: v.failureKind, reason: error && !v.success ? `${v.reason || 'ERROR'}: ${error.message}` : v.reason,
    detail: v.detail || null, ms, steps: Array.isArray(result.steps) ? result.steps.length : Number(result.steps) || 0, tierCounts: result.tierCounts || {},
    agentError: error ? error.message : (result.ok === false ? result.error || 'agent reported ok:false' : null),
    impossibleReported: !!result.impossible, needsConfirmation: !!result.needsConfirmation, visitId: result.visitId || null,
  };
}

module.exports = { runGoal, DEFAULT_TIMEOUT_MS };
