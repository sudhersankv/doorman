'use strict';
/**
 * Pure benchmark metrics over agent results (src/sim/agent.js output + the goal's answer key).
 * Each result: { goalId, success, failureKind, reason, ms, steps, tierCounts, impossibleReported, possible, flaw, kind }.
 * (`possible`, `flaw`, `kind` are copied from the goal by run.js; a `goal` sub-object is also accepted.)
 */

const quantile = (sorted, q) => {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
};
const rate = (num, den) => (den ? +(num / den).toFixed(4) : 0);
const field = (r, k) => (r[k] !== undefined ? r[k] : r.goal ? r.goal[k] : undefined);

/**
 * Summarize a list of results.
 * @param {Array<object>} results
 * @returns {{ n, successPossible, impossibleHandled, medianMs, p90Ms, llmFallbackRate, recipeHitRate, avgSteps, byFlaw, byKind }}
 */
function summarize(results = []) {
  const n = results.length;
  const possible = results.filter((r) => field(r, 'possible') === true);
  const impossible = results.filter((r) => field(r, 'possible') === false);
  const ms = results.map((r) => Number(r.ms) || 0).sort((a, b) => a - b);
  let allSteps = 0, llmSteps = 0, recipeGoals = 0, stepSum = 0;
  for (const r of results) {
    const tc = r.tierCounts || {};
    const total = Object.values(tc).reduce((a, b) => a + (Number(b) || 0), 0) || Number(r.steps) || 0;
    allSteps += total; llmSteps += Number(tc.T2_llm) || 0; stepSum += Number(r.steps) || total;
    if ((Number(tc.T1_recipe) || 0) > 0) recipeGoals++;
  }
  const group = (key) => {
    const out = {};
    for (const r of results) {
      const k = field(r, key); if (k == null) continue;
      const g = out[k] || (out[k] = { n: 0, success: 0, handled: 0, possible: 0, impossible: 0 });
      g.n++;
      if (field(r, 'possible')) { g.possible++; if (r.success) g.success++; } else { g.impossible++; if (r.impossibleReported) g.handled++; }
    }
    for (const g of Object.values(out)) { g.successRate = rate(g.success, g.possible); g.handledRate = rate(g.handled, g.impossible); }
    return out;
  };
  return {
    n,
    successPossible: rate(possible.filter((r) => r.success).length, possible.length),
    impossibleHandled: rate(impossible.filter((r) => r.impossibleReported === true).length, impossible.length),
    medianMs: Math.round(quantile(ms, 0.5)),
    p90Ms: Math.round(quantile(ms, 0.9)),
    llmFallbackRate: rate(llmSteps, allSteps),
    recipeHitRate: rate(recipeGoals, n),
    avgSteps: n ? +(stepSum / n).toFixed(2) : 0,
    byFlaw: group('flaw'),
    byKind: group('kind'),
  };
}

module.exports = { summarize, quantile };
