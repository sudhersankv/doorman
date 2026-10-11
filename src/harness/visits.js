'use strict';
/**
 * Visits: one record per agent visit (CONTRACTS.md §8), plus the two reads the editor needs:
 * `worst` (compact failure traces) and `metrics` (numbers per config version).
 */

const COLLECTION = 'visits';
const LLM_TIER = 'T2_llm';

/**
 * Insert a visit record.
 * @param {{ siteId, visitId?, goal, goalVector?, history, outcome, failureReason?, ms, tierCounts?, configVersion, agentReported?, deps }} args
 */
async function log({ siteId, visitId = null, goal, goalVector = null, history = [], outcome, failureReason = null, ms = 0, tierCounts = {}, configVersion = null, agentReported = null, deps }) {
  const doc = {
    siteId, visitId, goal, goalEmbedding: goalVector, history, outcome, failureReason, ms,
    tierCounts: tierCounts && Object.keys(tierCounts).length ? tierCounts : countTiers(history), configVersion, agentReported,
    steps: (history || []).length, createdAt: new Date().toISOString(),
  };
  const { insertedId } = await deps.db.col(COLLECTION).insertOne(doc);
  return { ...doc, _id: insertedId };
}

function countTiers(history) {
  const out = {};
  for (const s of history || []) if (s && s.tier) out[s.tier] = (out[s.tier] || 0) + 1;
  return out;
}

const trace = (v) => ({
  goal: v.goal, outcome: v.outcome, failureReason: v.failureReason || null,
  steps: (v.history || []).map((s) => ({
    action: s.action ?? null, tier: s.tier, confidence: s.confidence, outcome: s.outcome,
    messagesAfter: (s.messagesAfter || []).slice(0, 2).map((m) => (typeof m === 'string' ? m : m.text)),
  })),
});

/**
 * Worst visits for the editor: failed, or impossible without the agent reporting it. Most steps first.
 * @param {{ siteId:string, configVersion?:number, limit?:number, deps:object }} args
 */
async function worst({ siteId, configVersion, limit = 10, deps }) {
  const filter = { siteId };
  if (configVersion != null) filter.configVersion = configVersion;
  const rows = await deps.db.col(COLLECTION).find(filter).toArray();
  return rows
    .filter((v) => v.outcome === 'failed' || (v.outcome === 'impossible' && !(v.agentReported && v.agentReported.impossible)))
    .sort((a, b) => ((b.history || []).length - (a.history || []).length) || (String(b.createdAt).localeCompare(String(a.createdAt))))
    .slice(0, limit)
    .map(trace);
}

/**
 * Aggregate numbers for a site (optionally one config version).
 * @returns {Promise<{ n, successRate, failureReasons, medianMs, llmFallbackRate, tierCounts }>}
 */
async function metrics({ siteId, configVersion, deps }) {
  const filter = { siteId };
  if (configVersion != null) filter.configVersion = configVersion;
  const rows = await deps.db.col(COLLECTION).find(filter).toArray();
  const n = rows.length;
  const failureReasons = {}, tierCounts = {};
  let success = 0, steps = 0;
  for (const v of rows) {
    if (v.outcome === 'success') success++;
    if (v.failureReason) failureReasons[v.failureReason] = (failureReasons[v.failureReason] || 0) + 1;
    const tc = v.tierCounts && Object.keys(v.tierCounts).length ? v.tierCounts : countTiers(v.history);
    for (const [t, c] of Object.entries(tc)) { tierCounts[t] = (tierCounts[t] || 0) + c; steps += c; }
  }
  const ms = rows.map((v) => Number(v.ms) || 0).sort((a, b) => a - b);
  const medianMs = n ? (n % 2 ? ms[(n - 1) / 2] : (ms[n / 2 - 1] + ms[n / 2]) / 2) : 0;
  return {
    n, successRate: n ? success / n : 0, failureReasons, medianMs,
    llmFallbackRate: steps ? (tierCounts[LLM_TIER] || 0) / steps : 0, tierCounts,
  };
}

module.exports = { COLLECTION, log, worst, metrics, countTiers };
