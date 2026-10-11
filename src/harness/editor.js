'use strict';
/**
 * The editor: the self-improvement loop (CONTRACTS.md §9).
 *   proposePatch -> an LLM reads the active config, metrics and the worst visits and proposes a JSON-Patch (≤ maxOps ops)
 *   evolveOnce   -> apply it as a new version, benchmark on held-out goals, keep or roll back by the §9 rule
 *   evolve       -> N generations of evolveOnce
 * Generic: knows nothing about any particular site's vocabulary.
 */
const cfg = require(process.env.DOORMAN_CONFIG_MODULE || './config');
const { parseJson } = require('../lib/llm');

const METRIC_KEYS = ['successPossible', 'impossibleHandled', 'medianMs', 'llmFallbackRate', 'recipeHitRate'];

/** Allowed patch paths + bounds, verbatim from CONTRACTS.md §4 (shown to the LLM). */
const ALLOWED_PATHS_TEXT = [
  'Patch = JSON-Patch subset [{op:"replace"|"add"|"remove", path, value}].',
  'Allowed paths: /tools/<key>/(description|exposed|precondition), /context/(includeMessages|includeItems|maxItems|historySteps|recipesTopK|recipeMinScore ∈ [0.75,0.97]),',
  '/jev/nextInstructions, /jev/confidenceThreshold ∈ [0.5,0.95], /guardrails/maxSteps ∈ [4,12], /guardrails/impossibleThreshold ∈ [0.6,0.95],',
  '/guardrails/confirm/- (add only; remove never allowed), /rules/- and /rules/<i> (replace/remove ok). Max 3 ops. Anything else → error.',
  'Guidance: /guardrails/confirm entries must be EXISTING action keys from the tools list. Prefer small, testable edits; a higher confidenceThreshold sends more steps to the slow model, a lower one trusts the fast model more; recipeMinScore controls how similar a past goal must be before its recipe is replayed.',
].join('\n');

// ---------- visits access (module per §8, with a built-in fallback on the `visits` collection) ----------
function loadVisitsModule() {
  try { return require(process.env.DOORMAN_VISITS_MODULE || './visits'); } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND') return {};
    throw e;
  }
}
const visitsMod = loadVisitsModule();

async function fallbackVisitRows({ siteId, configVersion, deps }) {
  const filter = { siteId }; if (configVersion != null) filter.configVersion = configVersion;
  return deps.db.col('visits').find(filter).toArray();
}
/** Worst visits for a config version: failures first, then slowest. */
async function worstVisits({ siteId, configVersion, limit = 5, deps }) {
  if (typeof visitsMod.worst === 'function') return visitsMod.worst({ siteId, configVersion, limit, deps });
  const rows = await fallbackVisitRows({ siteId, configVersion, deps });
  const rank = (v) => (v.outcome === 'failed' ? 0 : v.outcome === 'impossible' ? 1 : 2);
  return rows.sort((a, b) => rank(a) - rank(b) || (b.ms || 0) - (a.ms || 0)).slice(0, limit);
}
/** Aggregate metrics over visits for a config version (same keys as the simulator's metrics). */
async function visitMetrics({ siteId, configVersion, deps }) {
  if (typeof visitsMod.metrics === 'function') return visitsMod.metrics({ siteId, configVersion, deps });
  const rows = await fallbackVisitRows({ siteId, configVersion, deps });
  if (!rows.length) return null;
  const n = rows.length;
  const ms = rows.map((r) => r.ms || 0).sort((a, b) => a - b);
  const sumTier = (k) => rows.reduce((a, r) => a + ((r.tierCounts || {})[k] || 0), 0);
  const steps = rows.reduce((a, r) => a + Object.values(r.tierCounts || {}).reduce((x, y) => x + y, 0), 0);
  return {
    visits: n,
    successPossible: rows.filter((r) => r.outcome === 'success').length / n,
    impossibleHandled: rows.filter((r) => r.outcome === 'impossible').length / n,
    medianMs: ms[Math.floor(n / 2)],
    llmFallbackRate: steps ? sumTier('T2_llm') / steps : 0,
    recipeHitRate: steps ? sumTier('T1_recipe') / steps : 0,
  };
}

// ---------- prompt building ----------
const cut = (s, n) => { const t = String(s ?? ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

/** Compact one-visit trace for the prompt: goal, outcome, failure reason, step list (no selectors). */
function compactVisit(v, i) {
  const steps = (v.steps || v.history || []).slice(0, 10).map((s) => {
    const p = s.params && Object.keys(s.params).length ? `(${cut(JSON.stringify(s.params), 40)})` : '';
    const msg = (s.messagesAfter || []).map((m) => (typeof m === 'string' ? m : m.text)).filter(Boolean).slice(0, 1).map((t) => ` msg:"${cut(t, 60)}"`).join('');
    return `${s.tier || '?'}:${s.action ?? 'null'}${p}${s.outcome === 'error' ? '!' : ''}${msg}`;
  });
  return `#${i + 1} goal="${cut(v.goal, 120)}" outcome=${v.outcome}${v.failureReason ? ' reason=' + v.failureReason : ''} ms=${v.ms ?? '?'}` +
    (v.tierCounts ? ` tiers=${JSON.stringify(v.tierCounts)}` : '') + `\n   steps: ${steps.join(' → ') || 'none'}`;
}

function formatMetrics(m) {
  if (!m) return 'no metrics yet for this version';
  const num = (x) => (typeof x === 'number' ? +x.toFixed(3) : x);
  const parts = METRIC_KEYS.filter((k) => m[k] != null).map((k) => `${k}=${num(m[k])}`);
  if (m.successRate != null && m.successPossible == null) parts.push(`successRate=${num(m.successRate)}`);
  if (m.failureReasons && Object.keys(m.failureReasons).length) parts.push(`failureReasons=${JSON.stringify(m.failureReasons)}`);
  if (m.tierCounts && Object.keys(m.tierCounts).length) parts.push(`tierCounts=${JSON.stringify(m.tierCounts)}`);
  const n = m.visits ?? m.n;
  return parts.join(', ') + (n != null ? ` (visits=${n})` : '');
}

/**
 * Build the editor prompt messages.
 * @returns {Array<{role:string, content:string}>}
 */
function buildMessages({ config, worstVisits: worst = [], metrics, maxOps, errors }) {
  const system = [
    'You are the EDITOR of a harness that sits at a website\'s door and guides visiting AI agents toward their goals.',
    'The harness behaviour is fully defined by a config: which page actions are exposed and how they are described, what context the fast decision model sees,',
    'the instructions and confidence threshold for that model, guardrails (step limit, impossible-detection threshold, actions requiring confirmation) and free-text rules.',
    'Your job: propose ONE small, well-motivated patch that will raise the success rate on possible goals, keep impossible goals handled, and cut latency / LLM fallbacks.',
    '',
    'PATCH FORMAT AND ALLOWED PATHS (strict):',
    ALLOWED_PATHS_TEXT,
    `Use at most ${maxOps} ops. Guardrails may only get STRICTER: never remove confirm entries, never raise maxSteps or lower thresholds unless the traces clearly show agents being cut off.`,
    'Prefer changes grounded in the traces: a rule that prevents a repeated mistake, a tool description/precondition that disambiguates, better nextInstructions, or context tweaks.',
    'Do not propose an op that leaves the config unchanged. Rules must be short, generic statements (no selectors).',
    '',
    'Respond with STRICT JSON only, no prose, exactly: { "rationale": string, "patch": [ { "op": "add"|"replace"|"remove", "path": string, "value": any } ] }',
  ].join('\n');

  const user = [
    '## Current harness config', cfg.summarizeForPrompt(config), '',
    '## Metrics for this version', formatMetrics(metrics), '',
    `## Worst visits (${worst.length})`, worst.length ? worst.map(compactVisit).join('\n') : 'none recorded', '',
    `Propose the patch now (≤ ${maxOps} ops, strict JSON).`,
  ];
  if (errors && errors.length) {
    user.push('', '## Your previous patch was REJECTED by the validator with these errors — fix them and answer again:', ...errors.map((e) => `- ${e}`));
  }
  return [{ role: 'system', content: system }, { role: 'user', content: user.join('\n') }];
}

/**
 * Ask the LLM for a config patch, validate it, retry once with the validator's errors.
 * @param {{ config: object, worstVisits?: object[], metrics?: object|null, deps: object, maxOps?: number }} args
 * @returns {Promise<{ patch: Array, rationale: string, raw: string, errors?: string[] }>}
 */
async function proposePatch({ config, worstVisits: worst = [], metrics = null, deps, maxOps = 3 }) {
  let errors = null, rationale = '', raw = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const messages = buildMessages({ config, worstVisits: worst, metrics, maxOps, errors });
    const res = await deps.llm.chat(messages, { json: true, tag: 'editor', maxTokens: 900 });
    raw = res.text;
    const out = parseJson(raw);
    if (!out || typeof out !== 'object') { errors = ['response was not valid JSON']; deps.log?.('editor-invalid', { attempt, errors }); continue; }
    rationale = typeof out.rationale === 'string' ? out.rationale : '';
    const patch = Array.isArray(out.patch) ? out.patch : [];
    const v = cfg.validatePatch(patch, config);
    errors = v.ok ? [] : [...v.errors];
    if (v.ok && patch.length > maxOps) errors.push(`patch has ${patch.length} ops; max ${maxOps}`);
    if (!errors.length) return { patch, rationale, raw };
    deps.log?.('editor-invalid', { attempt, errors });
  }
  return { patch: [], rationale, raw, errors: errors || [] };
}

/**
 * §9 keep rule.
 * @param {object} before metrics of the current version
 * @param {object} after metrics of the candidate version
 * @returns {boolean}
 */
function keepRuleDefault(before, after) {
  if (!after || !before) return false;
  const bS = before.successPossible ?? 0, aS = after.successPossible ?? 0;
  if (aS > bS + 0.02) return true;
  const bMs = before.medianMs, aMs = after.medianMs;
  return aS >= bS - 0.02 && typeof aMs === 'number' && typeof bMs === 'number' && aMs < bMs * 0.9;
}

const pickMetrics = (m) => { if (!m) return null; const o = {}; for (const k of Object.keys(m)) if (typeof m[k] !== 'object' || m[k] === null) o[k] = m[k]; return o; };

/**
 * One generation: benchmark the active version (if needed), propose + apply a patch, benchmark the candidate, keep or roll back.
 * @param {{ siteId: string, deps: object, runGoals: (split:string, configVersion:number) => Promise<object>, keepRule?: Function, trainFirst?: boolean, maxOps?: number }} args
 * @returns {Promise<{ from:number, to:number|null, patch:Array, rationale:string, verdict:'kept'|'rolled_back'|'no_patch', before:object|null, after:object|null, errors?: string[] }>}
 */
async function evolveOnce({ siteId, deps, runGoals, keepRule = keepRuleDefault, trainFirst = true, maxOps = 3, reuseBaseline = false }) {
  const opts = { reuseBaseline };
  const log = deps.log || (() => {});
  const current = await cfg.loadActive(siteId, deps);
  const from = current.version;

  // Baseline on held-out goals. Re-measured every generation unless `reuseBaseline` is set: recipes and visits
  // accumulate between generations, so a stale "before" would not be comparable with the fresh "after".
  let before = opts.reuseBaseline && current.eval && current.eval.heldout ? current.eval.heldout : null;
  if (!before) {
    before = pickMetrics(await runGoals('heldout', from));
    await cfg.setEval(siteId, from, { eval: { ...(current.eval || {}), heldout: before }, verdict: current.verdict ?? null }, deps);
  }

  const [worst, metrics] = await Promise.all([
    worstVisits({ siteId, configVersion: from, limit: 5, deps }),
    visitMetrics({ siteId, configVersion: from, deps }),
  ]);
  const hasVisits = metrics && (metrics.visits ?? metrics.n ?? 1) > 0;
  const proposal = await proposePatch({ config: current, worstVisits: worst, metrics: hasVisits ? { ...before, ...metrics } : before, deps, maxOps });
  log('editor-proposal', { from, ops: proposal.patch.length, rationale: cut(proposal.rationale, 200), errors: proposal.errors });
  if (!proposal.patch.length) {
    return { from, to: null, patch: [], rationale: proposal.rationale, verdict: 'no_patch', before, after: null, errors: proposal.errors || [] };
  }

  const draft = cfg.applyPatch(current, proposal.patch);
  // version numbers are allocated from the site's history (max+1), not parent+1: after a rollback the
  // active config is still the old one and parent+1 would collide with the rolled-back version.
  const all = await cfg.history(siteId, deps);
  draft.version = Math.max(current.version, ...all.map((v) => v.version || 0)) + 1;
  const candidate = await cfg.saveVersion(draft, deps);
  const to = candidate.version;
  const evalDoc = {};
  if (trainFirst) evalDoc.train = pickMetrics(await runGoals('train', to));
  const after = pickMetrics(await runGoals('heldout', to));
  evalDoc.heldout = after;

  const keep = keepRule(before, after);
  const verdict = keep ? 'kept' : 'rolled_back';
  if (keep) await cfg.activate(siteId, to, deps);
  await cfg.setEval(siteId, to, { eval: { ...evalDoc, before, after }, verdict }, deps);
  log('editor-verdict', { from, to, verdict, before, after });
  return { from, to, patch: proposal.patch, rationale: proposal.rationale, verdict, before, after };
}

/**
 * Run several generations in sequence.
 * @param {{ siteId: string, generations?: number, deps: object, runGoals: Function, onGeneration?: (result:object, i:number) => any, keepRule?: Function, trainFirst?: boolean, maxOps?: number }} args
 * @returns {Promise<object[]>} results of each generation
 */
async function evolve({ siteId, generations = 3, deps, runGoals, onGeneration, keepRule, trainFirst, maxOps, reuseBaseline }) {
  const results = [];
  for (let i = 0; i < generations; i++) {
    const r = await evolveOnce({ siteId, deps, runGoals, keepRule, trainFirst, maxOps, reuseBaseline });
    results.push(r);
    if (onGeneration) await onGeneration(r, i);
  }
  return results;
}

module.exports = { proposePatch, evolveOnce, evolve, buildMessages, keepRule: keepRuleDefault, worstVisits, visitMetrics, ALLOWED_PATHS_TEXT, METRIC_KEYS };
