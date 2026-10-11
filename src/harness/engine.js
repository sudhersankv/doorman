'use strict';
/**
 * Decision engine (CONTRACTS §5): T0 tool -> T1 recipe -> T1 Jev -> T2 LLM, plus the confirmation gate and outcome verification.
 * All functions take `deps` ({ jev, embed, llm, recipes?, log }) and a harness `config` (§4). Generic: no site-specific vocabulary.
 */
const constraints = require('./constraints');
const { parseJson } = require('../lib/llm');

const FAILURE_REASONS = ['not_found', 'validation_error', 'login_required', 'unavailable', 'blocked', 'other'];
const MAX_STATE_CHARS = 6000;
const RECIPE_MIN_SCORE = 0.88; // default; config.context.recipeMinScore overrides (the editor may tune it)

const DEFAULTS = {
  version: 0,
  tools: {},
  context: { includeMessages: true, includeItems: true, maxItems: 12, historySteps: 4, recipesTopK: 3 },
  jev: { nextInstructions: 'Choose the single action that moves closest to completing the goal on THIS page. Choose `done` only if the goal is clearly already achieved.', confidenceThreshold: 0.7 },
  guardrails: { confirm: [], maxSteps: 8, impossibleThreshold: 0.8 },
  rules: [],
};

/** Fill missing config sections with defaults (does not mutate). */
function withDefaults(config) {
  const c = config || {};
  return {
    ...DEFAULTS, ...c,
    tools: c.tools || {},
    context: { ...DEFAULTS.context, ...(c.context || {}) },
    jev: { ...DEFAULTS.jev, ...(c.jev || {}) },
    guardrails: { ...DEFAULTS.guardrails, ...(c.guardrails || {}), confirm: (c.guardrails && c.guardrails.confirm) || [] },
    rules: Array.isArray(c.rules) ? c.rules : [],
  };
}

const clip = (s, n) => { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const noop = () => {};

/** Actions on the page that the config exposes (tools[key].exposed !== false). */
function exposedActions(page, config) {
  const tools = (config && config.tools) || {};
  return ((page && page.actions) || []).filter((a) => a && a.key && !(tools[a.key] && tools[a.key].exposed === false));
}

function describeAction(a, config) {
  const t = ((config && config.tools) || {})[a.key] || {};
  const out = { key: a.key, kind: a.kind, name: clip(a.name, 60) };
  if (a.options) out.options = a.options.slice(0, 20).map((o) => clip(o.label || o.value, 40));
  if (t.description) out.description = clip(t.description, 160);
  if (t.precondition) out.precondition = clip(t.precondition, 120);
  return out;
}

/**
 * Compact, selector-free JSON state for Jev honoring config.context. Items are pre-filtered by goal constraints.
 * @param {{goal:string, page:object, history?:object[], config?:object, recipes?:object[]}} args
 */
function buildState({ goal, page, history = [], config, recipes = [] }) {
  const cfg = withDefaults(config);
  const ctx = cfg.context;
  const cons = constraints.parse(goal);
  const state = { goal: clip(goal, 300), url: clip(page && page.url, 200), title: clip(page && page.title, 80), constraints: cons };
  state.actions = exposedActions(page, cfg).map((a) => describeAction(a, cfg));
  state.fields = ((page && page.fields) || []).map((f) => ({ key: f.key, name: clip(f.name, 50), value: clip(f.value, 40) }));
  if (ctx.includeItems) {
    const items = constraints.filterItems((page && page.items) || [], cons);
    state.items = items.slice(0, Math.max(0, ctx.maxItems | 0)).map((it) => ({ key: it.key, text: clip(it.text, 120), attrs: it.attrs || {}, actionKeys: (it.actionKeys || []).slice(0, 4) }));
    state.itemsTotal = ((page && page.items) || []).length;
    state.itemsMatching = items.length;
  }
  if (ctx.includeMessages) state.messages = ((page && page.messages) || []).slice(0, 6).map((m) => ({ role: m.role, text: clip(m.text, 160) }));
  const steps = Math.max(0, ctx.historySteps | 0);
  state.history = history.slice(-steps).map((h) => ({ action: h.action, params: h.params || undefined, outcome: h.outcome, messagesAfter: (h.messagesAfter || []).slice(0, 2).map((m) => clip(typeof m === 'string' ? m : m.text, 80)) }));
  state.stepIndex = history.length;
  if (cfg.rules.length) state.rules = cfg.rules.map((r) => clip(r, 200));
  if (recipes && recipes.length) state.recipes = recipes.slice(0, Math.max(0, ctx.recipesTopK | 0)).map((r) => ({ goalPattern: clip(r.goalPattern, 100), steps: (r.steps || []).map((s) => s.action).slice(0, 10), score: r.score != null ? +Number(r.score).toFixed(2) : undefined }));
  // size budget: shrink items, then messages, then history
  let n = JSON.stringify(state).length;
  while (n > MAX_STATE_CHARS && state.items && state.items.length) { state.items.pop(); n = JSON.stringify(state).length; }
  if (n > MAX_STATE_CHARS && state.actions.length > 40) state.actions = state.actions.slice(0, 40);
  if (n > MAX_STATE_CHARS && state.messages) state.messages = state.messages.slice(0, 2);
  if (JSON.stringify(state).length > MAX_STATE_CHARS) state.history = state.history.slice(-1);
  return state;
}

// ---------- questions ----------

/** Jev questions for the main step: `next` choice (actions + done), `feasible` and `needs_confirmation` nouls. */
/**
 * Generic loop hygiene (harness rule, not site knowledge):
 *  - repeat guard: an action issued with identical params in the last two steps is excluded (unless nothing else is left);
 *  - alert hint: when the page answered the last step with an alert, say so and prefer actions whose name overlaps it.
 */
function sameParams(a, b) { return JSON.stringify(a || {}) === JSON.stringify(b || {}); }
function decisionActions(page, config, history = []) {
  const all = exposedActions(page, config);
  const last = history[history.length - 1];
  if (last && last.confirmed) return all; // a confirmed action must be re-issuable
  const prev = history[history.length - 2];
  const same = (h, a) => h && h.action === a.key && (a.kind === 'select' || a.kind === 'type' ? sameParams(h.params, last.params) : true);
  // block an immediate repeat (same action right again) or a two-step loop (A, A); allow A → B → A (a retry after fixing the cause)
  const filtered = all.filter((a) => !(same(last, a) || (same(last, a) && same(prev, a))));
  return filtered.length ? filtered : all;
}
function lastAlert(history = []) {
  const h = history[history.length - 1];
  if (!h) return null;
  const msgs = (h.messagesAfter || []).filter((m) => m && (typeof m === 'string' || m.role === 'alert')).map((m) => (typeof m === 'string' ? m : m.text) || '').filter(Boolean);
  return msgs.length ? msgs[0] : null;
}
function alertHint(page, config, history) {
  const alert = lastAlert(history);
  if (!alert) return '';
  const words = new Set(String(alert).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3));
  const addressing = exposedActions(page, config).filter((a) => String(a.name).toLowerCase().split(/[^a-z0-9]+/).some((w) => w.length > 3 && words.has(w))).map((a) => a.key);
  return ` The page answered the last step with: "${clip(alert, 120)}".` + (addressing.length ? ` Actions that address it: ${addressing.join(', ')}. Prefer one of them before repeating the last action.` : ' Do not simply repeat the last action.');
}

function questionsForNext({ page, config, history = [] }) {
  const cfg = withDefaults(config);
  const criteria = {};
  for (const a of decisionActions(page, cfg, history)) {
    const t = cfg.tools[a.key] || {};
    criteria[a.key] = clip(`${a.kind} ${a.name}${t.description ? ' — ' + t.description : ''}${t.precondition ? ' (requires: ' + t.precondition + ')' : ''}`, 200);
  }
  criteria.done = 'Nothing left to do on this site; stop here.';
  return {
    next: { type: 'choice', instructions: cfg.jev.nextInstructions + alertHint(page, cfg, history), criteria },
    feasible: { type: 'noul', instructions: 'Is the goal plausibly possible (feasible) on this site given this page? Consider whether messages say something is not found, unavailable or not offered.' },
    needs_confirmation: { type: 'noul', instructions: 'Would the next action commit the visitor to something irreversible (pay, order, submit, book, delete)? Confirm needed?' },
  };
}

/** Jev slot questions for the chosen action: `value` (select), `text` (type), `item` (link inside an item). */
function questionsForSlots({ goal, page, action, config }) {
  const cfg = withDefaults(config);
  const qs = {};
  if (!action) return qs;
  const cons = constraints.parse(goal);
  if (action.kind === 'select' && Array.isArray(action.options) && action.options.length) {
    const allowed = action.options.filter((o) => constraints.optionAllowed(`${o.label || ''} ${o.value || ''}`, cons));
    const opts = allowed.length ? allowed : action.options;
    const criteria = {};
    for (const o of opts.slice(0, 30)) criteria[String(o.value)] = clip(o.label || String(o.value), 60);
    qs.value = { type: 'choice', instructions: `Which option of "${clip(action.name, 40)}" best matches the goal?`, criteria };
  } else if (action.kind === 'type') {
    const criteria = {};
    for (const p of constraints.candidatePhrases(goal)) criteria[p] = null;
    qs.text = { type: 'choice', instructions: `Which short phrase should be typed into "${clip(action.name, 40)}" to pursue the goal?`, criteria };
  }
  const items = constraints.filterItems((page && page.items) || [], cons).filter((it) => (it.actionKeys || []).length);
  const targets = items.filter((it) => it.actionKeys.includes(action.key));
  if (targets.length > 1) {
    const criteria = {};
    for (const it of targets.slice(0, Math.max(1, cfg.context.maxItems | 0))) criteria[it.key] = clip(it.text, 100);
    qs.item = { type: 'choice', instructions: 'Which item best matches the goal (respecting its numeric constraints)?', criteria };
  }
  return qs;
}

/** Jev questions for verifyOutcome. */
function questionsForVerify() {
  const criteria = {
    not_found: 'What the goal asked for does not exist or could not be found on the site.',
    validation_error: 'A form rejected the input: invalid value, missing field or wrong format.',
    login_required: 'The site asked to sign in / log in / create an account.',
    unavailable: 'The thing exists but is sold out, fully booked, out of stock or closed.',
    blocked: 'A guardrail, confirmation, captcha or permission stopped progress.',
    other: 'Something else or unclear.',
  };
  return {
    satisfied: { type: 'noul', instructions: 'Looking at messages and the last steps, was the goal successfully achieved / completed on the final page?' },
    failure_reason: { type: 'choice', instructions: 'Pick the failure reason that best explains the messages and the last steps ; ignore if satisfied.', criteria },
  };
}

// ---------- helpers ----------

/** Pick the item (if any) whose actionKeys contain the action, honoring a chosen item key. */
function itemFor(page, actionKey, chosenItemKey) {
  const items = (page && page.items) || [];
  if (chosenItemKey) { const it = items.find((i) => i.key === chosenItemKey); if (it) return it; }
  return items.find((i) => (i.actionKeys || []).includes(actionKey)) || null;
}

function isConfirmed(history, key) {
  const last = history[history.length - 1];
  return !!(last && last.confirmed === true && last.action === key);
}

function gate({ step, config, history }) {
  const cfg = withDefaults(config);
  if (step.action && cfg.guardrails.confirm.includes(step.action) && !isConfirmed(history, step.action)) {
    return { ...step, needsConfirmation: true, done: false, impossible: false, reason: `"${step.action}" requires confirmation` };
  }
  return step;
}

function finalize(step, trace) {
  return { action: null, params: {}, confidence: 1, done: false, impossible: false, needsConfirmation: false, reason: '', ...step, trace };
}

async function fillSlots({ goal, page, action, config, deps, trace }) {
  const qs = questionsForSlots({ goal, page, action, config });
  const params = {};
  let itemKey = null;
  if (Object.keys(qs).length) {
    const res = await deps.jev.decide(buildState({ goal, page, history: [], config }), qs);
    trace.jevMs += res.ms || 0; trace.jevCalls++;
    const a = res.answers || {};
    if (a.value && a.value.choice != null) params.value = String(a.value.choice);
    if (a.text && a.text.choice != null) params.text = String(a.text.choice);
    if (a.item && a.item.choice != null) itemKey = String(a.item.choice);
  } else if (action.kind === 'type') params.text = constraints.candidatePhrases(goal)[0];
  else if (action.kind === 'select' && action.options && action.options.length) params.value = String(action.options[0].value);
  return { params, itemKey };
}

// ---------- tiers ----------

async function tierRecipe({ goal, page, history, config, deps, goalVector, trace }) {
  if (!deps.recipes || typeof deps.recipes.find !== 'function') return null;
  const cfg = withDefaults(config);
  let vec = goalVector;
  if (!vec && deps.embed) { try { vec = (await deps.embed.embed([goal], 'query'))[0]; } catch { return null; } }
  if (!vec) return null;
  let found;
  try { found = await deps.recipes.find({ siteId: page.siteId, goalVector: vec, topK: cfg.context.recipesTopK, deps }); } catch { return null; }
  if (!found || !found.length) return null;
  const top = found[0];
  const minScore = typeof cfg.context.recipeMinScore === 'number' ? cfg.context.recipeMinScore : RECIPE_MIN_SCORE;
  if (!(top.score >= minScore) || !Array.isArray(top.steps)) return null;
  const idx = history.filter((h) => h && h.tier === 'T1_recipe').length;
  const next = top.steps[history.length] || top.steps[idx];
  if (!next) return null;
  let action = null, chosenItem = null;
  if (next.action === '$ITEM') {
    // "pick the matching item": filter items by the goal's numeric constraints, let Jev choose, then use that item's action
    const cons = constraints.parse(goal);
    const cands = constraints.filterItems((page.items || []).filter((it) => (it.actionKeys || []).length), cons).slice(0, Math.max(1, cfg.context.maxItems | 0));
    if (!cands.length) return null;
    const criteria = {}; for (const it of cands) criteria[it.key] = clip(it.text, 100);
    const state = buildState({ goal, page, history, config: cfg, recipes: found });
    const res = await deps.jev.decide(state, { item: { type: 'choice', instructions: 'Which item best matches the goal (respecting its numeric constraints)?', criteria } });
    trace.jevMs += res.ms || 0; trace.jevCalls++;
    const pick = res.answers && res.answers.item;
    if (!pick || typeof pick.confidence !== 'number' || pick.confidence < cfg.jev.confidenceThreshold) return null; // let the Jev tier decide instead
    chosenItem = cands.find((it) => it.key === pick.choice);
    if (!chosenItem) return null;
    const exposed = exposedActions(page, cfg);
    action = exposed.find((a) => (chosenItem.actionKeys || []).includes(a.key) && (!next.kind || a.kind === next.kind)) || exposed.find((a) => (chosenItem.actionKeys || []).includes(a.key));
  } else {
    action = exposedActions(page, cfg).find((a) => a.key === next.action);
  }
  if (!action) return null;
  trace.recipeId = top._id;
  const params = { ...(next.params || {}) };
  const blank = (v) => v === '$BLANK' || v == null;
  let item = null;
  if (blank(params.value) && action.kind !== 'select') delete params.value;
  if (blank(params.text) && action.kind !== 'type') delete params.text;
  if ((action.kind === 'select' && blank(params.value)) || (action.kind === 'type' && blank(params.text)) || itemFor(page, action.key)) {
    const filled = await fillSlots({ goal, page, action, config: cfg, deps, trace });
    if (action.kind === 'select' && blank(params.value)) params.value = filled.params.value;
    if (action.kind === 'type' && blank(params.text)) params.text = filled.params.text;
    item = itemFor(page, action.key, filled.itemKey);
  }
  const step = { action: action.key, params, tier: 'T1_recipe', confidence: Math.min(0.99, top.score), reason: `recipe "${clip(top.goalPattern, 60)}" step ${history.length + 1}`, recipes: found, kind: action.kind };
  if (chosenItem) item = chosenItem;
  if (item) step.itemKey = item.key;
  return step;
}

async function tierLlm({ goal, page, history, config, deps, trace, state, hint }) {
  const cfg = withDefaults(config);
  const keys = decisionActions(page, cfg, history).map((a) => a.key);
  const sys = 'You are the decision engine for an agent visiting a website. Reply with JSON only: {"action": <one of the allowed keys or null>, "params": {"value"?: string, "text"?: string}, "done": boolean, "impossible": boolean, "reason": string}. "done" when the goal is already achieved; "impossible" when the site cannot satisfy it.';
  const user = `STATE:\n${JSON.stringify(state)}\n\nALLOWED ACTION KEYS: ${JSON.stringify(keys)}${hint ? '\nHINT: ' + hint : ''}${alertHint(page, cfg, history)}`;
  const res = await deps.llm.chat([{ role: 'system', content: sys }, { role: 'user', content: user }], { json: true, tag: 'decide', maxTokens: 300 });
  trace.llmMs += res.ms || 0;
  const out = parseJson(res.text) || {};
  const step = { tier: 'T2_llm', confidence: 0.6, reason: clip(out.reason || 'llm', 200), params: {} };
  if (out.impossible === true) return { ...step, action: null, impossible: true };
  if (out.done === true) return { ...step, action: null, done: true };
  const action = out.action && exposedActions(page, cfg).find((a) => a.key === out.action);
  if (!action) return { ...step, action: null, reason: `llm proposed unknown action "${clip(out.action, 40)}"` };
  const p = out.params && typeof out.params === 'object' ? out.params : {};
  if (action.kind === 'select') {
    const ok = (action.options || []).find((o) => String(o.value) === String(p.value) || String(o.label) === String(p.value));
    step.params.value = ok ? String(ok.value) : String(((action.options || [])[0] || {}).value ?? p.value ?? '');
  }
  if (action.kind === 'type') step.params.text = String(p.text ?? p.value ?? constraints.candidatePhrases(goal)[0]);
  const item = itemFor(page, action.key, p.item);
  if (item) step.itemKey = item.key;
  return { ...step, action: action.key, kind: action.kind };
}

async function tierJev({ goal, page, history, config, deps, trace, recipes, force }) {
  const cfg = withDefaults(config);
  const state = buildState({ goal, page, history, config: cfg, recipes });
  let a = {};
  if (!force) {
    const qs = questionsForNext({ page, config: cfg, history });
    const res = await deps.jev.decide(state, qs);
    trace.jevMs += res.ms || 0; trace.jevCalls++;
    a = res.answers || {};
  } else {
    a = { next: { choice: force, confidence: cfg.jev.confidenceThreshold }, feasible: { noul: 1 } }; // forced: skip the main question, still fill slots
  }
  const feasible = a.feasible && typeof a.feasible.noul === 'number' ? a.feasible.noul : 1;
  const next = a.next || {};
  const confidence = typeof next.confidence === 'number' ? next.confidence : 0;
  // Infeasible: judged on the first steps, or at any step right after the page answered with an alert
  // (e.g. "no results", "out of stock", "invalid"). Later steps without an alert never stop the visit.
  const alerted = !!lastAlert(history);
  if ((history.length <= 1 || alerted) && feasible < 1 - cfg.guardrails.impossibleThreshold) {
    return { step: { action: null, impossible: true, tier: 'T1_jev', confidence: +(1 - feasible).toFixed(3), reason: `goal judged infeasible (feasible=${feasible.toFixed(2)}${alerted ? ', after an alert' : ''})` }, state };
  }
  if (confidence < cfg.jev.confidenceThreshold || next.choice == null) return { step: null, state, low: { choice: next.choice, confidence } };
  if (next.choice === 'done') return { step: { action: null, done: true, tier: 'T1_jev', confidence, reason: 'Jev: goal already achieved' }, state };
  const action = exposedActions(page, cfg).find((x) => x.key === next.choice);
  if (!action) return { step: null, state, low: { choice: next.choice, confidence } };
  const { params, itemKey } = await fillSlots({ goal, page, action, config: cfg, deps, trace });
  const step = { action: action.key, params, tier: 'T1_jev', confidence, reason: `Jev chose ${action.kind} "${clip(action.name, 40)}"`, kind: action.kind };
  const item = itemFor(page, action.key, itemKey);
  if (item) step.itemKey = item.key;
  return { step, state };
}

/**
 * Decide the next step (CONTRACTS §2/§5): T0 requested tool -> T1 recipe -> T1 Jev -> T2 LLM; then the confirmation gate.
 * @param {{goal:string, page:object, history?:object[], config?:object, deps:object, goalVector?:number[]}} args
 * @returns {Promise<object>} step with `trace: { jevMs, llmMs, recipeId, configVersion, jevCalls }`
 */
async function decide({ goal, page, history = [], config, deps, goalVector }) {
  const cfg = withDefaults(config);
  const log = (deps && deps.log) || noop;
  const trace = { jevMs: 0, llmMs: 0, recipeId: null, configVersion: cfg.version, jevCalls: 0 };
  const done = (step) => finalize(gate({ step, config: cfg, history }), trace);
  history = Array.isArray(history) ? history : [];

  // T0: the visitor called an exposed tool directly.
  const requested = page && page.requestedTool;
  if (history.length === 0 && requested) {
    const key = typeof requested === 'string' ? requested : requested.key || requested.name;
    const params = (typeof requested === 'object' && requested.params) || {};
    const action = exposedActions(page, cfg).find((a) => a.key === key);
    if (action) return done({ action: key, params, tier: 'T0_tool', confidence: 1, reason: 'requested tool' });
    log('engine.t0-unknown', { key });
  }

  // T1 recipe
  let recipes = [];
  try {
    const r = await tierRecipe({ goal, page, history, config: cfg, deps, goalVector, trace });
    if (r) { recipes = r.recipes; delete r.recipes; return done(r); }
  } catch (e) { log('engine.recipe-error', { error: String(e && e.message) }); }

  // T1 Jev
  let state, low = null;
  try {
    const r = await tierJev({ goal, page, history, config: cfg, deps, trace, recipes });
    state = r.state;
    if (r.step) return done(r.step);
    low = r.low;
  } catch (e) {
    log('engine.jev-error', { error: String(e && e.message) });
    state = buildState({ goal, page, history, config: cfg, recipes });
    low = { error: String(e && e.message) };
  }

  // T2 LLM
  try {
    const hint = low && low.choice != null ? `a fast model leaned toward "${low.choice}" with low confidence ${Number(low.confidence || 0).toFixed(2)}` : null;
    const step = await tierLlm({ goal, page, history, config: cfg, deps, trace, state, hint });
    if (step.action || step.done || step.impossible) return done(step);
    // LLM gave nothing usable: fall back to Jev's best guess rather than stalling the visit.
    if (low && low.choice && low.choice !== 'done') {
      log('engine.llm-invalid-fallback', { choice: low.choice });
      const fb = await tierJev({ goal, page, history, config: cfg, deps, trace, recipes, force: low.choice });
      if (fb && fb.step) return done({ ...fb.step, reason: `llm unusable; used fast-model top choice (${Number(low.confidence || 0).toFixed(2)})` });
    }
    return done(step);
  } catch (e) {
    log('engine.llm-error', { error: String(e && e.message) });
    if (low && low.choice && low.choice !== 'done') {
      try {
        const fb = await tierJev({ goal, page, history, config: cfg, deps, trace, recipes, force: low.choice });
        if (fb && fb.step) return done({ ...fb.step, reason: `llm error; used fast-model top choice (${Number(low.confidence || 0).toFixed(2)})` });
      } catch {}
    }
    return finalize({ action: null, done: false, impossible: false, tier: 'T2_llm', confidence: 0, error: String(e && e.message), reason: 'decision failed' }, trace);
  }
}

/**
 * Verify the outcome of a visit with one Jev call.
 * @returns {Promise<{satisfied:number, failureReason:string|null, ms:number}>}
 */
async function verifyOutcome({ goal, finalPage, history = [], deps, config }) {
  const cfg = withDefaults(config);
  const state = buildState({ goal, page: finalPage || {}, history, config: { ...cfg, context: { ...cfg.context, includeMessages: true, historySteps: Math.max(cfg.context.historySteps, 3) } } });
  state.task = 'verify';
  const res = await deps.jev.decide(state, questionsForVerify());
  const a = res.answers || {};
  const satisfied = a.satisfied && typeof a.satisfied.noul === 'number' ? Math.max(0, Math.min(1, a.satisfied.noul)) : 0;
  let failureReason = null;
  if (satisfied < 0.5) {
    const c = a.failure_reason && a.failure_reason.choice;
    failureReason = FAILURE_REASONS.includes(c) ? c : 'other';
  }
  return { satisfied, failureReason, ms: res.ms || 0 };
}

module.exports = { decisionActions, alertHint, decide, buildState, verifyOutcome, questionsFor: { next: questionsForNext, slots: questionsForSlots, verify: questionsForVerify }, questionsForNext, questionsForSlots, questionsForVerify, exposedActions, withDefaults, FAILURE_REASONS };
