'use strict';
/**
 * Doorman server on node:http (no express). CONTRACTS.md §2, §3.
 *   createServer({ deps, engine, config, recipes, visits, siteDefaults }) -> http.Server
 * Routes: static /shop/*, /doorman.js, /evolution/*; GET /.well-known/doorman.json, /health,
 *   /api/config?site=, /api/evolution?site=, /api/runs?site=; POST /api/map, /api/decide, /api/visit.
 * Every harness module is injectable so tests can run without the real engine.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PUBLIC = path.join(__dirname, 'public');
const BODY_LIMIT = 1024 * 1024;
const VERSION = require('./package.json').version || '0.1.0';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8' };

/** require() a sibling module, or return null when it is not written yet (parallel development). */
function optional(mod) { try { return require(mod); } catch (e) { if (e.code === 'MODULE_NOT_FOUND' && String(e.message).includes(mod.replace('./', ''))) return null; throw e; } }

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

function countTiers(history) {
  const out = {};
  for (const s of history || []) if (s && s.tier) out[s.tier] = (out[s.tier] || 0) + 1;
  return out;
}

/**
 * Build the server. All collaborators are optional; missing ones are loaded from src/harness when present.
 * @param {{ deps:object, engine?:object, config?:object, recipes?:object, visits?:object, siteDefaults?:object }} opts
 * @returns {import('node:http').Server}
 */
function createServer({ deps, engine, config, recipes, visits, siteDefaults = {} } = {}) {
  if (!deps) throw new Error('createServer: deps required');
  engine = engine || optional('./src/harness/engine');
  config = config || optional('./src/harness/config');
  recipes = recipes || optional('./src/harness/recipes');
  visits = visits || optional('./src/harness/visits');
  if (recipes && !deps.recipes) deps = { ...deps, recipes }; // the engine's recipe tier looks for deps.recipes
  const site = { siteId: 'trailhead', configCacheMs: 5000, ...siteDefaults };
  const log = deps.log || (() => {});

  // ---- caches ----
  const configCache = new Map(); // siteId -> { at, value }
  const visitCache = new Map(); // visitId -> { goalVector, startedAt, siteId }
  const VISIT_TTL = 30 * 60 * 1000;
  const sweepVisits = () => { const now = Date.now(); for (const [k, v] of visitCache) if (now - v.startedAt > VISIT_TTL) visitCache.delete(k); };

  const fallbackConfig = (siteId) => ({ siteId, version: 1, parent: null, active: true, createdBy: 'seed', tools: {}, context: { includeMessages: true, includeItems: true, maxItems: 12, historySteps: 4, recipesTopK: 3 }, jev: { nextInstructions: '', confidenceThreshold: 0.7 }, guardrails: { confirm: [], maxSteps: 8, impossibleThreshold: 0.8 }, rules: [], eval: null, patch: null, verdict: null, createdAt: new Date().toISOString() });

  /**
   * Active config for a site, cached `configCacheMs`. Only /api/decide seeds (it knows the page's action keys, which
   * seed guardrails.confirm); read-only routes return the stored config or an unsaved default.
   */
  async function activeConfig(siteId, actionKeys = [], { seed = false } = {}) {
    const hit = configCache.get(siteId);
    if (hit && Date.now() - hit.at < site.configCacheMs) return hit.value;
    let value = await deps.db.col('harness_configs').findOne({ siteId, active: true });
    if (!value) {
      if (seed && config && config.loadActive) value = await config.loadActive(siteId, deps, { actionKeys });
      else return config && config.defaultConfig ? config.defaultConfig(siteId, { actionKeys }) : fallbackConfig(siteId);
    }
    configCache.set(siteId, { at: Date.now(), value });
    return value;
  }

  /** Append-only: new action keys matching the confirm seed pattern join the active config's guardrails.confirm. */
  async function seedConfirm(siteId, actionKeys) {
    const re = (config && config.CONFIRM_SEED_RE) || /pay|order|purchase|submit|delete|book|confirm/i;
    const cfg = await deps.db.col('harness_configs').findOne({ siteId, active: true });
    if (!cfg) return;
    const have = new Set(cfg.guardrails?.confirm || []);
    const add = actionKeys.filter((k) => re.test(String(k)) && !have.has(k));
    if (!add.length) return;
    await deps.db.col('harness_configs').updateOne({ siteId, version: cfg.version }, { $set: { guardrails: { ...cfg.guardrails, confirm: [...have, ...add] } } });
    configCache.delete(siteId);
  }

  async function goalVectorFor(visitId, goal) {
    const v = visitCache.get(visitId);
    if (v && v.goalVector) return v.goalVector;
    let goalVector = null;
    try { [goalVector] = await deps.embed.embed([String(goal || '')], 'query'); } catch (e) { log('embed-error', { error: e.message }); }
    const entry = v || { startedAt: Date.now() };
    entry.goalVector = goalVector;
    visitCache.set(visitId, entry);
    return goalVector;
  }

  const publicConfig = (c) => { if (!c) return null; const { _id, ...rest } = c; return { ...rest, _id: _id == null ? undefined : String(_id) }; };

  // ---- handlers ----
  const routes = {
    async 'GET /health'() { return { ok: true, version: VERSION, siteId: site.siteId, engine: !!engine, db: deps.db?.name || 'unknown', now: new Date().toISOString() }; },

    async 'GET /.well-known/doorman.json'(req, url) {
      const siteId = url.searchParams.get('site') || site.siteId;
      const maps = await deps.db.col('site_maps').find({ siteId }).toArray();
      const latest = maps.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0];
      const cfg = await activeConfig(siteId).catch(() => null);
      const tools = (latest?.actions || []).filter((a) => cfg?.tools?.[a.key]?.exposed !== false).map((a) => ({
        name: a.key, description: cfg?.tools?.[a.key]?.description || `${a.kind}: ${a.name}`,
        inputSchema: a.kind === 'type' ? { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
          : a.kind === 'select' ? { type: 'object', properties: { value: { type: 'string', enum: (a.options || []).map((o) => o.value) } }, required: ['value'] }
          : { type: 'object', properties: {} },
      }));
      return {
        siteId, version: VERSION, protocol: 'doorman/1', configVersion: cfg?.version ?? null,
        endpoints: { decide: '/api/decide', visit: '/api/visit', map: '/api/map', config: `/api/config?site=${siteId}`, evolution: `/api/evolution?site=${siteId}`, script: '/doorman.js' },
        tools, templates: maps.length, mappedAt: latest?.updatedAt || null,
      };
    },

    async 'POST /api/map'(req, url, body) {
      const { siteId = site.siteId, templateHash, url: pageUrl, title, actions = [], items = [], fields = [], counts } = body || {};
      if (!templateHash) throw new HttpError(400, 'templateHash required');
      const now = new Date().toISOString();
      await deps.db.col('site_maps').updateOne({ siteId, templateHash },
        { $set: { url: pageUrl, title, actions, fields, counts: counts || { actions: actions.length, items: items.length }, sampleItems: items.slice(0, 3), updatedAt: now }, $inc: { seen: 1 } },
        { upsert: true });
      await seedConfirm(siteId, actions.map((a) => a && a.key).filter(Boolean));
      configCache.delete(siteId); // tool keys may have changed
      return { ok: true, siteId, templateHash };
    },

    async 'POST /api/decide'(req, url, body) {
      const { siteId = site.siteId, goal, page, history = [] } = body || {};
      if (!goal || typeof goal !== 'string') throw new HttpError(400, 'goal (string) required');
      if (!page || typeof page !== 'object') throw new HttpError(400, 'page (snapshot) required');
      if (!engine || !engine.decide) throw new HttpError(503, 'engine not available');
      const visitId = body.visitId || crypto.randomUUID();
      if (!visitCache.has(visitId)) { sweepVisits(); visitCache.set(visitId, { startedAt: Date.now(), siteId }); }
      const cfg = await activeConfig(siteId, (page.actions || []).map((a) => a.key), { seed: true });
      const goalVector = await goalVectorFor(visitId, goal);
      const t0 = Date.now();
      const out = await engine.decide({ goal, page, history, config: cfg, deps, goalVector, visitId, siteId });
      const step = out && out.step ? out.step : out;
      const trace = { ...(out && out.trace ? out.trace : {}), ...(step && step.trace ? step.trace : {}) };
      if (step && step.trace) delete step.trace;
      const result = {
        visitId,
        step: {
          action: step?.action ?? null, params: step?.params || {}, tier: step?.tier || 'T2_llm', confidence: Number(step?.confidence ?? 0),
          done: !!step?.done, impossible: !!step?.impossible, needsConfirmation: !!step?.needsConfirmation, reason: step?.reason || '',
        },
        trace: { jevMs: trace.jevMs ?? 0, llmMs: trace.llmMs ?? 0, ...(trace.recipeId ? { recipeId: trace.recipeId } : {}), configVersion: cfg.version, totalMs: Date.now() - t0 },
      };
      log('decide', { visitId, tier: result.step.tier, action: result.step.action, ms: result.trace.totalMs });
      return result;
    },

    async 'POST /api/visit'(req, url, body) {
      const { visitId, siteId = site.siteId, goal, history = [], finalPage = null, agentReported = {} } = body || {};
      if (!goal || typeof goal !== 'string') throw new HttpError(400, 'goal (string) required');
      if (!engine || !engine.verifyOutcome) throw new HttpError(503, 'engine not available');
      const cached = visitCache.get(visitId) || {};
      const cfg = await activeConfig(siteId);
      const goalVector = cached.goalVector || (await goalVectorFor(visitId || crypto.randomUUID(), goal));
      let verdict = { satisfied: 0, failureReason: 'other' };
      try { verdict = (await engine.verifyOutcome({ goal, finalPage, history, deps, config: cfg })) || verdict; } catch (e) { log('verify-error', { error: e.message }); }
      const satisfied = Number(verdict.satisfied) || 0;
      const outcome = agentReported?.impossible ? 'impossible' : satisfied >= 0.5 ? 'success' : 'failed';
      const failureReason = outcome === 'success' ? null : (verdict.failureReason || (outcome === 'impossible' ? 'unavailable' : 'other'));
      const ms = Number(body.ms) || (cached.startedAt ? Date.now() - cached.startedAt : 0);
      const tierCounts = countTiers(history);
      const rec = { siteId, visitId: visitId || null, goal, goalVector, history, outcome, failureReason, ms, tierCounts, configVersion: cfg.version, agentReported, deps };
      if (visits && visits.log) await visits.log(rec);
      else await deps.db.col('visits').insertOne({ ...rec, deps: undefined, goalEmbedding: goalVector, goalVector: undefined, steps: history.length, createdAt: new Date().toISOString() });
      let recipeSaved = false;
      if (outcome === 'success' && recipes && recipes.saveFromHistory) {
        try { recipeSaved = !!(await recipes.saveFromHistory({ siteId, goal, goalVector, history, deps })); } catch (e) { log('recipe-error', { error: e.message }); }
      }
      if (visitId) visitCache.delete(visitId);
      log('visit', { visitId, outcome, failureReason, ms, steps: history.length });
      return { ok: true, visit: { visitId: visitId || null, outcome, failureReason, satisfied, ms, tierCounts, recipeSaved, configVersion: cfg.version } };
    },

    async 'GET /api/config'(req, url) {
      const siteId = url.searchParams.get('site') || site.siteId;
      return publicConfig(await activeConfig(siteId));
    },

    async 'GET /api/evolution'(req, url) {
      const siteId = url.searchParams.get('site') || site.siteId;
      let versions;
      if (config && config.history) versions = await config.history(siteId, deps);
      else versions = (await deps.db.col('harness_configs').find({ siteId }).toArray()).sort((a, b) => a.version - b.version);
      const out = [];
      for (const v of versions) {
        let m = null;
        if (visits && visits.metrics) m = await visits.metrics({ siteId, configVersion: v.version, deps });
        else { const rows = await deps.db.col('visits').find({ siteId, configVersion: v.version }).toArray(); m = { n: rows.length, successRate: rows.length ? rows.filter((r) => r.outcome === 'success').length / rows.length : 0 }; }
        out.push({ version: v.version, parent: v.parent ?? null, active: !!v.active, createdBy: v.createdBy, createdAt: v.createdAt, patch: v.patch || null, rationale: v.rationale || null, eval: v.eval || null, verdict: v.verdict || null, rules: v.rules || [], metrics: m });
      }
      return { siteId, versions: out };
    },

    async 'GET /api/runs'(req, url) {
      const siteId = url.searchParams.get('site') || site.siteId;
      const rows = await deps.db.col('runs').find({ siteId }).toArray();
      const runs = rows.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt))).map((r) => ({
        runId: r.runId, split: r.split, configVersion: r.configVersion, startedAt: r.startedAt, finishedAt: r.finishedAt, metrics: r.metrics, n: Array.isArray(r.results) ? r.results.length : (r.metrics?.n ?? 0),
      }));
      return { siteId, runs };
    },
  };

  // ---- plumbing ----
  function send(res, status, body, headers = {}) {
    const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data), ...headers });
    res.end(data);
  }
  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = []; let size = 0, over = false;
      req.on('data', (c) => { size += c.length; if (over) return; if (size > BODY_LIMIT) { over = true; chunks.length = 0; return; } chunks.push(c); });
      req.on('end', () => {
        if (over) return reject(new HttpError(413, 'body too large (1 MB limit)'));
        if (!chunks.length) return resolve({});
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400, 'invalid JSON body')); }
      });
      req.on('error', reject);
    });
  }
  function serveStatic(res, root, rel, { indexFallback = false } = {}) {
    const safe = path.normalize('/' + decodeURIComponent(rel)).replace(/^(\.\.[/\\])+/, '');
    let file = path.join(root, safe);
    if (!file.startsWith(root)) return send(res, 403, { error: 'forbidden' });
    const tryFile = (f) => { try { const st = fs.statSync(f); return st.isFile() ? f : st.isDirectory() ? tryFile(path.join(f, 'index.html')) : null; } catch { return null; } };
    let found = tryFile(file);
    if (!found && indexFallback) found = tryFile(path.join(root, 'index.html'));
    if (!found) return send(res, 404, { error: 'not found' });
    const data = fs.readFileSync(found);
    send(res, 200, data, { 'Content-Type': MIME[path.extname(found)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    try {
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (p === '/') { res.writeHead(302, { Location: '/shop/' }); return res.end(); }
        if (p === '/doorman.js') return serveStatic(res, PUBLIC, 'doorman.js');
        if (p.startsWith('/shop')) return serveStatic(res, path.join(PUBLIC, 'shop'), p.slice('/shop'.length) || '/', { indexFallback: true });
        if (p.startsWith('/evolution')) return serveStatic(res, path.join(PUBLIC, 'evolution'), p.slice('/evolution'.length) || '/', { indexFallback: true });
      }
      const handler = routes[`${req.method} ${p}`];
      if (!handler) throw new HttpError(404, `no route ${req.method} ${p}`);
      const body = req.method === 'POST' ? await readBody(req) : null;
      const out = await handler(req, url, body);
      return send(res, 200, out == null ? { error: 'not found' } : out);
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) log('error', { path: p, error: e.message });
      return send(res, status, { error: e.message || 'internal error' });
    }
  });
  server.doorman = { clearCaches: () => { configCache.clear(); visitCache.clear(); }, site };
  return server;
}

module.exports = { createServer, countTiers };

if (require.main === module) {
  require('./src/lib/env'); // loads .env into process.env
  const { makeDeps } = require('./src/lib');
  (async () => {
    const deps = await makeDeps(process.env);
    const server = createServer({ deps, siteDefaults: { siteId: process.env.SITE_ID || 'trailhead' } });
    const port = Number(process.env.PORT) || 3000;
    server.listen(port, () => console.log(`Doorman server on http://localhost:${port}  (shop: /shop/, manifest: /.well-known/doorman.json)`));
  })().catch((e) => { console.error('boot failed:', e.message); process.exit(1); });
}
