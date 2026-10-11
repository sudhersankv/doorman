'use strict';
/**
 * Harness config: defaults, JSON-Patch-subset validation, application, and the `harness_configs` store.
 * See CONTRACTS.md §4. Generic: tool keys are whatever action keys the page exposes.
 */

const COLLECTION = 'harness_configs';
const CONFIRM_SEED_RE = /pay|order|purchase|submit|delete|book|confirm|checkout/i;
const MAX_OPS = 3;

const BOUNDS = {
  '/jev/confidenceThreshold': { min: 0.5, max: 0.95 },
  '/guardrails/maxSteps': { min: 4, max: 12, int: true },
  '/guardrails/impossibleThreshold': { min: 0.6, max: 0.95 },
  '/context/maxItems': { min: 4, max: 30, int: true },
  '/context/historySteps': { min: 1, max: 8, int: true },
  '/context/recipesTopK': { min: 1, max: 5, int: true },
};
const LIMITS = { description: 300, nextInstructions: 600, rule: 200, precondition: 300 };

const clone = (x) => JSON.parse(JSON.stringify(x));

/**
 * Build the seed config for a site.
 * @param {string} siteId
 * @param {{ actionKeys?: string[] }} [opts] action keys from the page; keys matching the confirm pattern seed `guardrails.confirm`.
 */
function defaultConfig(siteId, { actionKeys = [] } = {}) {
  const confirm = [...new Set(actionKeys.filter((k) => CONFIRM_SEED_RE.test(String(k))))];
  return {
    siteId, version: 1, parent: null, active: true, createdBy: 'seed',
    tools: {},
    context: { includeMessages: true, includeItems: true, maxItems: 12, historySteps: 4, recipesTopK: 3 },
    jev: {
      nextInstructions: 'Choose the single action that moves closest to completing the goal on THIS page. Choose `done` only if the goal is clearly already achieved.',
      confidenceThreshold: 0.70,
    },
    guardrails: { confirm, maxSteps: 8, impossibleThreshold: 0.80 },
    rules: [],
    eval: null, patch: null, verdict: null,
    createdAt: new Date().toISOString(),
  };
}

function checkNumber(path, value, errors) {
  const b = BOUNDS[path];
  if (typeof value !== 'number' || Number.isNaN(value)) { errors.push(`${path}: value must be a number`); return; }
  if (b.int && !Number.isInteger(value)) errors.push(`${path}: value must be an integer`);
  if (value < b.min || value > b.max) errors.push(`${path}: value ${value} outside [${b.min}, ${b.max}]`);
}
function checkString(path, value, max, errors) {
  if (typeof value !== 'string') { errors.push(`${path}: value must be a string`); return; }
  if (value.length > max) errors.push(`${path}: string longer than ${max} chars`);
}

/** Validate one op; pushes messages onto errors. */
function validateOp(op, i, config, errors) {
  const pre = `op[${i}]`;
  if (!op || typeof op !== 'object') { errors.push(`${pre}: not an object`); return; }
  if (!['add', 'replace', 'remove'].includes(op.op)) { errors.push(`${pre}: op must be add|replace|remove`); return; }
  if (typeof op.path !== 'string' || !op.path.startsWith('/')) { errors.push(`${pre}: path must be a string starting with /`); return; }
  const path = op.path, hasValue = 'value' in op;
  if (op.op !== 'remove' && !hasValue) { errors.push(`${pre}: ${op.op} requires value`); return; }
  const parts = path.slice(1).split('/');
  let m;

  // /tools/<key>/(description|exposed|precondition)
  if ((m = /^\/tools\/([^/]+)\/(description|exposed|precondition)$/.exec(path))) {
    if (op.op === 'remove') { if (m[2] === 'exposed') errors.push(`${pre}: cannot remove ${path}`); return; }
    if (m[2] === 'exposed') { if (typeof op.value !== 'boolean') errors.push(`${pre}: ${path} must be boolean`); }
    else checkString(path, op.value, LIMITS[m[2]], errors);
    return;
  }
  // /context/*
  if (parts[0] === 'context' && parts.length === 2) {
    const k = parts[1];
    if (op.op === 'remove') { errors.push(`${pre}: cannot remove ${path}`); return; }
    if (k === 'includeMessages' || k === 'includeItems') { if (typeof op.value !== 'boolean') errors.push(`${pre}: ${path} must be boolean`); return; }
    if (BOUNDS[path]) { checkNumber(path, op.value, errors); return; }
    errors.push(`${pre}: unknown path ${path}`); return;
  }
  // /jev/*
  if (path === '/jev/nextInstructions') { if (op.op === 'remove') errors.push(`${pre}: cannot remove ${path}`); else checkString(path, op.value, LIMITS.nextInstructions, errors); return; }
  if (path === '/jev/confidenceThreshold') { if (op.op === 'remove') errors.push(`${pre}: cannot remove ${path}`); else checkNumber(path, op.value, errors); return; }
  // /guardrails/*
  if (path === '/guardrails/maxSteps' || path === '/guardrails/impossibleThreshold') { if (op.op === 'remove') errors.push(`${pre}: cannot remove ${path}`); else checkNumber(path, op.value, errors); return; }
  if (path === '/guardrails/confirm/-') {
    if (op.op !== 'add') { errors.push(`${pre}: confirm is append-only (${op.op} not allowed)`); return; }
    if (typeof op.value !== 'string' || !op.value) errors.push(`${pre}: confirm entry must be a non-empty string`);
    return;
  }
  if (path.startsWith('/guardrails/confirm')) { errors.push(`${pre}: confirm is append-only; only add to /guardrails/confirm/- is allowed`); return; }
  // /rules/- and /rules/<i>
  if (path === '/rules/-') {
    if (op.op !== 'add') { errors.push(`${pre}: /rules/- only supports add`); return; }
    checkString(path, op.value, LIMITS.rule, errors); return;
  }
  if ((m = /^\/rules\/(\d+)$/.exec(path))) {
    const idx = Number(m[1]), len = (config?.rules || []).length;
    if (idx >= len) errors.push(`${pre}: rule index ${idx} out of range (${len} rules)`);
    if (op.op !== 'remove') checkString(path, op.value, LIMITS.rule, errors);
    return;
  }
  errors.push(`${pre}: unknown path ${path}`);
}

/**
 * Validate a patch (JSON-Patch subset) against a config.
 * @param {Array<{op:string,path:string,value?:any}>} patch
 * @param {object} config
 * @returns {{ ok: boolean, errors: string[] }}
 */
function validatePatch(patch, config) {
  const errors = [];
  if (!Array.isArray(patch)) return { ok: false, errors: ['patch must be an array'] };
  if (patch.length === 0) errors.push('patch is empty');
  if (patch.length > MAX_OPS) errors.push(`patch has ${patch.length} ops; max ${MAX_OPS}`);
  patch.forEach((op, i) => validateOp(op, i, config, errors));
  return { ok: errors.length === 0, errors };
}

/**
 * Apply a (validated) patch: returns a new version; the input is not mutated.
 * @param {object} config
 * @param {Array} patch
 * @returns {object} newConfig
 */
function applyPatch(config, patch) {
  const next = clone(config);
  for (const op of patch) {
    const parts = op.path.slice(1).split('/');
    if (parts[0] === 'tools') {
      const [, key, field] = parts;
      if (op.op === 'remove') { if (next.tools[key]) delete next.tools[key][field]; continue; }
      if (!next.tools[key]) next.tools[key] = { exposed: true };
      next.tools[key][field] = op.value;
    } else if (parts[0] === 'rules') {
      if (parts[1] === '-') next.rules.push(op.value);
      else if (op.op === 'remove') next.rules.splice(Number(parts[1]), 1);
      else next.rules[Number(parts[1])] = op.value;
    } else if (op.path === '/guardrails/confirm/-') {
      if (!next.guardrails.confirm.includes(op.value)) next.guardrails.confirm.push(op.value);
    } else {
      const [section, field] = parts;
      next[section][field] = op.value;
    }
  }
  next.version = config.version + 1;
  next.parent = config.version;
  next.createdBy = 'editor';
  next.active = false;
  next.patch = clone(patch);
  next.eval = null; next.verdict = null;
  next.createdAt = new Date().toISOString();
  delete next._id;
  return next;
}

// ---------- store ----------

/**
 * Load the active config for a site, seeding and inserting the default when none exists.
 * @param {string} siteId
 * @param {{db:object}} deps
 * @param {{ actionKeys?: string[] }} [opts] passed to defaultConfig on seed
 */
async function loadActive(siteId, deps, opts = {}) {
  const col = deps.db.col(COLLECTION);
  const found = await col.findOne({ siteId, active: true });
  if (found) return found;
  const seed = defaultConfig(siteId, opts);
  try {
    const { insertedId } = await col.insertOne(seed);
    return { ...seed, _id: insertedId };
  } catch (e) {
    // Concurrent first visits race to seed v1; the unique (siteId, version) index lets exactly one win. Re-read.
    if (e && (e.code === 11000 || /duplicate key/i.test(String(e.message)))) {
      const again = await col.findOne({ siteId, active: true });
      if (again) return again;
    }
    throw e;
  }
}

/** Insert a config version. Returns the stored doc. */
async function saveVersion(config, deps) {
  const doc = clone(config); delete doc._id;
  const { insertedId } = await deps.db.col(COLLECTION).insertOne(doc);
  return { ...doc, _id: insertedId };
}

/** Make `version` the active config for `siteId`; deactivates every other version. */
async function activate(siteId, version, deps) {
  const col = deps.db.col(COLLECTION);
  await col.updateMany({ siteId }, { $set: { active: false } });
  await col.updateOne({ siteId, version }, { $set: { active: true } });
  return col.findOne({ siteId, version });
}

/** Record evaluation results + verdict ("kept"|"rolled_back") on a version. */
async function setEval(siteId, version, { eval: ev, verdict }, deps) {
  await deps.db.col(COLLECTION).updateOne({ siteId, version }, { $set: { eval: ev ?? null, verdict: verdict ?? null } });
  return deps.db.col(COLLECTION).findOne({ siteId, version });
}

/** All versions for a site, ascending by version. */
async function history(siteId, deps) {
  const rows = await deps.db.col(COLLECTION).find({ siteId }).toArray();
  return rows.sort((a, b) => a.version - b.version);
}

/**
 * Compact text description of a config for the editor LLM prompt (≤ 1500 chars).
 * @param {object} config
 */
function summarizeForPrompt(config) {
  const cut = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s));
  const lines = [];
  lines.push(`config v${config.version} (site ${config.siteId})`);
  const tools = Object.entries(config.tools || {});
  lines.push(`tools (${tools.length}): ` + (tools.length
    ? tools.slice(0, 12).map(([k, t]) => `${k}${t.exposed === false ? '[hidden]' : ''}${t.description ? '="' + cut(t.description, 40) + '"' : ''}${t.precondition ? ' if:' + cut(t.precondition, 30) : ''}`).join('; ')
    : 'none (all page actions exposed, no descriptions)'));
  const c = config.context;
  lines.push(`context: messages=${c.includeMessages} items=${c.includeItems} maxItems=${c.maxItems} historySteps=${c.historySteps} recipesTopK=${c.recipesTopK}`);
  lines.push(`jev: confidenceThreshold=${config.jev.confidenceThreshold} nextInstructions="${cut(config.jev.nextInstructions, 300)}"`);
  const g = config.guardrails;
  lines.push(`guardrails: maxSteps=${g.maxSteps} impossibleThreshold=${g.impossibleThreshold} confirm=[${g.confirm.join(', ')}]`);
  const rules = config.rules || [];
  lines.push(`rules (${rules.length}): ` + (rules.length ? rules.map((r, i) => `[${i}] ${cut(r, 120)}`).join(' | ') : 'none'));
  let out = lines.join('\n');
  if (out.length > 1500) out = out.slice(0, 1497) + '…';
  return out;
}

module.exports = {
  COLLECTION, CONFIRM_SEED_RE, MAX_OPS, BOUNDS, LIMITS,
  defaultConfig, validatePatch, applyPatch,
  loadActive, saveVersion, activate, setEval, history, summarizeForPrompt,
};
