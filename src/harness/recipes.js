'use strict';
/**
 * Recipes: reusable action sequences learned from successful visits (CONTRACTS.md §8).
 * Stored in `recipes` with a `goalEmbedding` vector; free-text and select values are blanked to "$BLANK".
 */

const COLLECTION = 'recipes';
const BLANK = '$BLANK';

/**
 * Turn a concrete goal into a pattern: numbers → N, quoted phrases → "X".
 * "buy X under $80" → "buy X under $N"; 'search for "wool socks"' → 'search for "X"'.
 * @param {string} goal
 */
function toGoalPattern(goal) {
  return String(goal || '')
    .replace(/"[^"]*"|'[^']*'|“[^”]*”/g, '"X"')
    .replace(/\d+(?:[.,]\d+)*/g, 'N')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Successful steps with free-text / select values blanked. */
function stepsFromHistory(history) {
  return (history || [])
    .filter((s) => s && s.action && s.outcome === 'ok')
    .map((s) => {
      const params = {};
      if (s.params && 'text' in s.params) params.text = BLANK;
      if (s.params && 'value' in s.params) params.value = BLANK;
      return { action: s.action, params };
    });
}

const sameSteps = (a, b) => a.length === b.length && a.every((s, i) => s.action === b[i].action);

/**
 * Nearest recipes for a goal vector. Skips recipes with `brokenAt` set.
 * @param {{ siteId:string, goalVector:number[], topK?:number, minScore?:number, deps:object }} args
 * @returns {Promise<Array<{_id, goalPattern, steps, score, successes, failures}>>}
 */
async function find({ siteId, goalVector, topK = 3, minScore = 0.0, deps }) {
  if (!Array.isArray(goalVector) || !goalVector.length) return [];
  const rows = await deps.db.vectorSearch(COLLECTION, { vector: goalVector, filter: { siteId }, limit: topK * 3 + 5 });
  return rows
    .filter((r) => !r.brokenAt && (r.score ?? 0) >= minScore)
    .slice(0, topK)
    .map((r) => ({ _id: r._id, goalPattern: r.goalPattern, steps: r.steps, score: r.score, successes: r.successes || 0, failures: r.failures || 0 }));
}

/**
 * Save a recipe from a successful visit. If a recipe with the same action sequence exists for the site,
 * its `successes` counter is incremented instead. Returns the recipe doc (or null when there are no ok steps).
 * @param {{ siteId:string, goal:string, goalVector:number[], history:Array, deps:object }} args
 */
async function saveFromHistory({ siteId, goal, goalVector, history, deps }) {
  const steps = stepsFromHistory(history);
  if (!steps.length) return null;
  const col = deps.db.col(COLLECTION);
  const existing = (await col.find({ siteId }).toArray()).find((r) => sameSteps(r.steps || [], steps));
  if (existing) {
    await col.updateOne({ _id: existing._id }, { $inc: { successes: 1 }, $set: { lastSeenAt: new Date().toISOString() } });
    return col.findOne({ _id: existing._id });
  }
  const doc = {
    siteId, goalPattern: toGoalPattern(goal), goalExample: String(goal || ''), goalEmbedding: goalVector, steps,
    successes: 1, failures: 0, brokenAt: null, createdAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(),
  };
  const { insertedId } = await col.insertOne(doc);
  return { ...doc, _id: insertedId };
}

/** Mark a recipe broken (excluded from `find`) and count the failure. */
async function markBroken(id, deps) {
  await deps.db.col(COLLECTION).updateOne({ _id: id }, { $set: { brokenAt: new Date().toISOString() }, $inc: { failures: 1 } });
  return deps.db.col(COLLECTION).findOne({ _id: id });
}

/** Count a failure without breaking the recipe. */
async function recordFailure(id, deps) {
  await deps.db.col(COLLECTION).updateOne({ _id: id }, { $inc: { failures: 1 } });
  return deps.db.col(COLLECTION).findOne({ _id: id });
}

module.exports = { COLLECTION, BLANK, toGoalPattern, stepsFromHistory, find, saveFromHistory, markBroken, recordFailure };
