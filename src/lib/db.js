'use strict';
/**
 * Atlas access with a tiny surface, plus an in-memory fake with brute-force vector search.
 * { col(name), vectorSearch(colName, { vector, filter, limit, index, path }), ensureIndexes(), close() }
 */
const { cosine } = require('./embeddings');
const COLLECTIONS = ['harness_configs', 'site_maps', 'recipes', 'visits', 'runs', 'goals'];
const VECTOR_INDEXES = [
  { col: 'recipes', name: 'recipes_vec', path: 'goalEmbedding' },
  { col: 'visits', name: 'visits_vec', path: 'goalEmbedding' },
];

async function makeDb({ uri, dbName = 'doorman', dims = 1024, log = () => {} } = {}) {
  if (!uri) throw new Error('makeDb: uri required');
  const { MongoClient } = require('mongodb'); // lazy: only needed where it is installed
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
  await client.connect();
  const db = client.db(dbName);
  return {
    name: 'atlas', raw: db,
    col: (n) => db.collection(n),
    async vectorSearch(colName, { vector, filter = {}, limit = 5, index, path = 'goalEmbedding', numCandidates }) {
      const ix = index || VECTOR_INDEXES.find((v) => v.col === colName)?.name;
      const pipeline = [
        { $vectorSearch: { index: ix, path, queryVector: vector, numCandidates: numCandidates || Math.max(50, limit * 10), limit, ...(Object.keys(filter).length ? { filter } : {}) } },
        { $addFields: { score: { $meta: 'vectorSearchScore' } } }, { $project: { [path]: 0 } },
      ];
      return db.collection(colName).aggregate(pipeline).toArray();
    },
    async ensureIndexes() {
      for (const c of COLLECTIONS) await db.createCollection(c).catch(() => {});
      await db.collection('harness_configs').createIndex({ siteId: 1, version: 1 }, { unique: true });
      await db.collection('harness_configs').createIndex({ siteId: 1, active: 1 });
      await db.collection('site_maps').createIndex({ siteId: 1, templateHash: 1 }, { unique: true });
      await db.collection('visits').createIndex({ siteId: 1, createdAt: -1 });
      await db.collection('runs').createIndex({ runId: 1 });
      for (const v of VECTOR_INDEXES) {
        const col = db.collection(v.col);
        const existing = await col.listSearchIndexes().toArray().catch(() => []);
        if (existing.find((x) => x.name === v.name)) continue;
        await col.createSearchIndex({ name: v.name, type: 'vectorSearch', definition: { fields: [
          { type: 'vector', path: v.path, numDimensions: dims, similarity: 'cosine' }, { type: 'filter', path: 'siteId' } ] } });
        log('db', { createdVectorIndex: v.name });
      }
    },
    async waitForIndexes(timeoutMs = 180000) {
      const t0 = Date.now();
      for (const v of VECTOR_INDEXES) {
        for (;;) {
          const [ix] = await db.collection(v.col).listSearchIndexes(v.name).toArray();
          if (ix?.queryable) break;
          if (Date.now() - t0 > timeoutMs) throw new Error(`index ${v.name} not queryable after ${timeoutMs} ms`);
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
    },
    close: () => client.close(),
  };
}

// ---------- fake ----------
function matches(doc, filter) {
  for (const [k, v] of Object.entries(filter || {})) {
    const dv = k.includes('.') ? k.split('.').reduce((o, p) => (o == null ? o : o[p]), doc) : doc[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
      if ('$in' in v && !v.$in.includes(dv)) return false;
      if ('$ne' in v && dv === v.$ne) return false;
      if ('$exists' in v && (dv !== undefined) !== v.$exists) return false;
      if ('$gte' in v && !(dv >= v.$gte)) return false;
      if ('$lte' in v && !(dv <= v.$lte)) return false;
      if ('$gt' in v && !(dv > v.$gt)) return false;
      if ('$lt' in v && !(dv < v.$lt)) return false;
    } else if (dv !== v && !(dv == null && v == null)) return false;
  }
  return true;
}
let oid = 1;
function makeFakeDb() {
  const store = Object.fromEntries(COLLECTIONS.map((c) => [c, []]));
  const clone = (d) => JSON.parse(JSON.stringify(d));
  const applyUpdate = (doc, update) => {
    if (update.$set) Object.assign(doc, clone(update.$set));
    if (update.$inc) for (const [k, v] of Object.entries(update.$inc)) doc[k] = (doc[k] || 0) + v;
    if (update.$push) for (const [k, v] of Object.entries(update.$push)) (doc[k] = doc[k] || []).push(clone(v));
    if (update.$unset) for (const k of Object.keys(update.$unset)) delete doc[k];
  };
  const col = (name) => {
    const arr = store[name] || (store[name] = []);
    const cursor = (rows) => {
      let r = rows; const c = {
        sort(spec) { const [[k, dir]] = Object.entries(spec); r = [...r].sort((a, b) => (a[k] > b[k] ? dir : a[k] < b[k] ? -dir : 0)); return c; },
        limit(n) { r = r.slice(0, n); return c; }, project() { return c; },
        async toArray() { return r.map(clone); },
      }; return c;
    };
    return {
      async insertOne(d) { const doc = clone(d); doc._id = doc._id ?? `id${oid++}`; arr.push(doc); return { insertedId: doc._id }; },
      async insertMany(ds) { const ids = []; for (const d of ds) ids.push((await this.insertOne(d)).insertedId); return { insertedIds: ids }; },
      find(f = {}) { return cursor(arr.filter((d) => matches(d, f))); },
      async findOne(f = {}) { const d = arr.find((x) => matches(x, f)); return d ? clone(d) : null; },
      async updateOne(f, u, o = {}) { const d = arr.find((x) => matches(x, f)); if (d) { applyUpdate(d, u); return { matchedCount: 1, modifiedCount: 1 }; } if (o.upsert) { const n = { ...clone(f) }; applyUpdate(n, u); await this.insertOne(n); return { upsertedCount: 1 }; } return { matchedCount: 0 }; },
      async updateMany(f, u) { let n = 0; for (const d of arr) if (matches(d, f)) { applyUpdate(d, u); n++; } return { modifiedCount: n }; },
      async deleteMany(f = {}) { const before = arr.length; store[name] = arr.filter((d) => !matches(d, f)); const n = before - store[name].length; return { deletedCount: n }; },
      async countDocuments(f = {}) { return arr.filter((d) => matches(d, f)).length; },
      async createIndex() {}, aggregate() { throw new Error('fake db: use vectorSearch()'); },
    };
  };
  return {
    name: 'fake-db', store,
    col,
    async vectorSearch(colName, { vector, filter = {}, limit = 5, path = 'goalEmbedding' }) {
      return (store[colName] || []).filter((d) => matches(d, filter) && Array.isArray(d[path]))
        .map((d) => ({ ...clone(d), score: (cosine(vector, d[path]) + 1) / 2 })).sort((a, b) => b.score - a.score).slice(0, limit)
        .map((d) => { delete d[path]; return d; });
    },
    async ensureIndexes() {}, async waitForIndexes() {}, async close() {},
  };
}

module.exports = { makeDb, makeFakeDb, COLLECTIONS, VECTOR_INDEXES };
