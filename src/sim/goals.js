'use strict';
/**
 * Benchmark goals = objective templates (the answer key) x natural phrasings (many voices).
 * The answer key (kind, params, possible, flaw) never comes from the LLM; the LLM only rewrites `text`.
 * CLI: node src/sim/goals.js [--offline]   -> writes data/goals.json (+ upserts `goals` collection when a db is configured)
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SITE_ID = 'trailhead';
const PERSONAS = ['terse', 'chatty', 'typo', 'formal'];
const PRODUCT_NAMES = {
  'trail-runner': 'Trail Runner', 'road-racer': 'Road Racer', featherlight: 'Featherlight Racer', 'summit-hiker': 'Summit Hiker', 'rain-boot': 'Rain Boot',
  'canvas-sneaker': 'Canvas Sneaker', 'leather-loafer': 'Leather Loafer', 'camp-sandal': 'Camp Sandal', 'rain-shell': 'Rain Shell Jacket', 'trail-shorts': 'Trail Shorts',
  'wool-socks': 'Wool Hiking Socks', bottle: 'Insulated Bottle',
};

/**
 * The objective templates. Each becomes one goal. `n` on a template expands it into n goals with different personas
 * (same answer key, different voice) — used for the planted flaws so every flaw has ~6 phrasings.
 */
function templates() {
  const T = [];
  const add = (t) => T.push(t);
  // ---- possible, clean (30) ----
  const carts = [['road-racer', 9], ['featherlight', 8], ['summit-hiker', 11], ['rain-boot', 8], ['canvas-sneaker', 7], ['leather-loafer', 10], ['camp-sandal', 12],
    ['rain-shell', 'M'], ['trail-shorts', 'L'], ['wool-socks', 'M'], ['bottle', null], ['trail-runner', 9], ['road-racer', 11], ['summit-hiker', 9], ['featherlight', 10], ['rain-shell', 'XL']];
  for (const [productId, size] of carts) add({ kind: 'add_to_cart', params: { productId, size }, possible: true, flaw: null });
  const orders = [['road-racer', 9, '10001'], ['canvas-sneaker', 8, '60601'], ['wool-socks', 'L', '30301'], ['bottle', null, '02134'], ['trail-shorts', 'M', '75201'], ['rain-boot', 9, '48201']];
  for (const [productId, size, zip] of orders) add({ kind: 'place_order', params: { productId, size, zip }, possible: true, flaw: null });
  for (const productId of ['trail-runner', 'summit-hiker', 'rain-shell', 'bottle', 'camp-sandal', 'featherlight', 'wool-socks', 'leather-loafer']) add({ kind: 'find', params: { productId }, possible: true, flaw: null });
  // ---- flaw A: Trail Runner size 10 always out of stock (6) ----
  add({ kind: 'add_to_cart', params: { productId: 'trail-runner', size: 10 }, possible: false, flaw: 'A', n: 6 });
  // ---- flaw B: checkout rejects ZIPs starting with 9 (6) ----
  const bad = [['road-racer', 9, '94111'], ['summit-hiker', 10, '90210'], ['canvas-sneaker', 9, '98101'], ['bottle', null, '95814'], ['rain-shell', 'L', '92101'], ['wool-socks', 'M', '97201']];
  for (const [productId, size, zip] of bad) add({ kind: 'place_order', params: { productId, size, zip }, possible: false, flaw: 'B' });
  // ---- flaw C: order tracking needs sign-in, link buried in footer — possible (6) ----
  add({ kind: 'view_order', params: { orderId: '1042', email: 'sam@example.com' }, possible: true, flaw: 'C', n: 6 });
  // ---- flaw D: no kids sizes / no vegan line (6) ----
  for (const topic of ['kids trail running shoes', 'vegan hiking boots', 'leather-free loafers', 'toddler sandals', 'vegan leather-free boots', "children's rain boots"]) add({ kind: 'impossible', params: { topic }, possible: false, flaw: 'D' });
  // ---- vague impossible, no planted flaw (6) ----
  for (const topic of ['gift wrapping for an order', 'booking an in-store fitting appointment', 'applying coupon code SAVE20', 'price matching a competitor', 'international shipping to Japan', 'live chat with a support agent']) add({ kind: 'impossible', params: { topic }, possible: false, flaw: null });
  return T;
}

const hash = (s) => crypto.createHash('sha1').update(s).digest();
/** Deterministic 2:1 train:heldout split by goal id. */
function splitFor(id) { return hash(id).readUInt32BE(0) % 3 === 0 ? 'heldout' : 'train'; }

const pname = (id) => PRODUCT_NAMES[id] || id || '';

/** Plain, neutral statement of a template (what the LLM paraphrases; also the formal offline fallback). */
function baseText(t) {
  const p = t.params;
  switch (t.kind) {
    case 'add_to_cart': return p.size == null ? `Add the ${pname(p.productId)} to my cart.` : `Add the ${pname(p.productId)} in size ${p.size} to my cart.`;
    case 'place_order': return `Buy the ${pname(p.productId)}${p.size == null ? '' : ` in size ${p.size}`} and place the order; ship to ${p.zip}.`;
    case 'view_order': return `Show me the status of my order #${p.orderId}.`;
    case 'find': return `Open the product page for the ${pname(p.productId)}.`;
    case 'impossible': return `I want ${p.topic}.`;
    default: return `Goal: ${t.kind}`;
  }
}

/** Deterministic phrasing per persona (offline mode and LLM fallback). Distinct text for each persona. */
const VARIANT_PREFIX = ['', 'Next up: ', 'One more thing - ', 'Also: '];
function offlineText(t, persona, variant = t.variant || 0) {
  const p = t.params; const name = pname(p.productId); const sz = p.size;
  const prefix = VARIANT_PREFIX[variant % VARIANT_PREFIX.length];
  const V = {
    add_to_cart: {
      terse: sz == null ? `${name} to cart` : `${name} size ${sz}, add to cart`,
      chatty: sz == null ? `Hey! Could you pop the ${name} into my cart for me? Thanks a bunch!` : `Hey! Could you grab the ${name} in a size ${sz} and put it in my cart? Thanks a bunch!`,
      typo: sz == null ? `add teh ${name.toLowerCase()} to my cart pls` : `add teh ${name.toLowerCase()} sz ${sz} to my cart pls`,
      formal: baseText(t),
    },
    place_order: {
      terse: `order ${name}${sz == null ? '' : ` size ${sz}`}, ship to ${p.zip}`,
      chatty: `I'd love to order the ${name}${sz == null ? '' : ` in size ${sz}`} — can you check out for me? Ship it to ZIP ${p.zip}, my name is Sam Trail, 1 Ferry Building.`,
      typo: `buy the ${name.toLowerCase()}${sz == null ? '' : ` (size ${sz})`} and chekout, zip ${p.zip}, name sam trail, 1 ferry bldg`,
      formal: `Please purchase the ${name}${sz == null ? '' : ` in size ${sz}`} and complete checkout for Sam Trail, 1 Ferry Building, ZIP ${p.zip}.`,
    },
    view_order: {
      terse: `order ${p.orderId} status`,
      chatty: `Hi there! Can you check where my order #${p.orderId} is? Sign me in as ${p.email} if you need to.`,
      typo: `wheres my ordr ${p.orderId}? email is ${p.email}`,
      formal: `Please look up order #${p.orderId} and tell me its status (account: ${p.email}).`,
    },
    find: {
      terse: `open ${name}`,
      chatty: `Can you find the ${name} for me and open its page? I want to read about it.`,
      typo: `find the ${name.toLowerCase()} prodcut page`,
      formal: baseText(t),
    },
    impossible: {
      terse: p.topic,
      chatty: `Hey, I'm looking for ${p.topic} — can you sort that out on this site?`,
      typo: `do u have ${p.topic}? wnat that`,
      formal: `I would like ${p.topic}; please arrange this on the site.`,
    },
  };
  return prefix + (V[t.kind]?.[persona] || baseText(t));
}

/** Expand templates into goal records (without `text`). Ids are stable across runs. */
function expand() {
  const out = []; const seen = new Set();
  let i = 0;
  for (const t of templates()) {
    const n = t.n || 1;
    for (let k = 0; k < n; k++) {
      const persona = PERSONAS[i % PERSONAS.length];
      const key = `${t.kind}:${JSON.stringify(t.params)}:${k}`;
      const id = `g${String(i + 1).padStart(3, '0')}_${t.kind}_${(t.flaw || 'ok').toLowerCase()}_${hash(key).toString('hex').slice(0, 6)}`;
      if (seen.has(id)) throw new Error(`duplicate goal id ${id}`);
      seen.add(id);
      out.push({ id, kind: t.kind, params: { ...t.params }, possible: !!t.possible, flaw: t.flaw || null, split: splitFor(id), persona, variant: Math.floor(k / PERSONAS.length), siteId: SITE_ID });
      i++;
    }
  }
  return out;
}

const PERSONA_STYLE = {
  terse: 'terse: a few words, no pleasantries, like a search box',
  chatty: 'chatty and friendly, one or two sentences, with a greeting',
  typo: 'casual with a couple of realistic typos and lowercase',
  formal: 'formal, polite, complete sentence',
};

/**
 * Ask the strong LLM for one natural phrasing per goal in the goal's persona. Falls back to the offline phrasing on any problem.
 * The LLM is never allowed to change the answer key; it only sees the neutral statement.
 */
async function paraphrase(goals, deps) {
  const { parseJson } = require('../lib/llm');
  const texts = Object.fromEntries(goals.map((g) => [g.id, offlineText(g, g.persona)]));
  const llm = deps?.llmStrong || deps?.llm;
  if (!llm) return texts;
  for (const persona of PERSONAS) {
    const batch = goals.filter((g) => g.persona === persona);
    if (!batch.length) continue;
    const list = batch.map((g) => ({ id: g.id, statement: baseText(g), ...(g.kind === 'place_order' ? { shipping: 'name Sam Trail, 1 Ferry Building' } : {}), ...(g.kind === 'view_order' ? { account: g.params.email } : {}) }));
    const messages = [
      { role: 'system', content: 'You rewrite shopping requests as a real customer would type them to an assistant. Keep every concrete detail (product name, size, ZIP code, order number, email, name, address) exactly; do not add or drop details. Return JSON: {"phrasings": {"<id>": "<text>"}} with ONE phrasing per id.' },
      { role: 'user', content: `Voice: ${PERSONA_STYLE[persona]}.\nRequests:\n${JSON.stringify(list, null, 1)}` },
    ];
    try {
      const { text } = await llm.chat(messages, { json: true, tag: 'goals', maxTokens: 2500 });
      const parsed = parseJson(text);
      const ph = parsed?.phrasings || parsed || {};
      for (const g of batch) {
        const v = ph[g.id];
        if (typeof v === 'string' && v.trim().length >= 3 && v.length <= 400) texts[g.id] = v.trim();
      }
    } catch (e) { (deps.log || (() => {}))('goals-llm-error', { persona, error: e.message }); }
  }
  return texts;
}

/**
 * Compose the full goal set.
 * @param {{ deps?:object, offline?:boolean }} [opts] offline -> deterministic template phrasings, no LLM call
 * @returns {Promise<Array<{id,kind,params,possible,flaw,split,text,persona}>>}
 */
async function composeGoals({ deps, offline = false } = {}) {
  const goals = expand();
  const texts = offline ? Object.fromEntries(goals.map((g) => [g.id, offlineText(g, g.persona)])) : await paraphrase(goals, deps);
  return goals.map((g) => ({ ...g, text: texts[g.id] }));
}

/** Map a goal record to the spec src/sim/verify.js expects. */
function toVerifySpec(goal) {
  const p = goal.params || {};
  const spec = { kind: goal.kind, flaw: goal.flaw || undefined };
  if (p.productId) spec.productId = p.productId;
  if (p.size != null) spec.size = p.size;
  if (p.orderId) spec.orderId = String(p.orderId);
  if (p.topic) spec.topic = p.topic;
  return spec;
}

/** Write data/goals.json and upsert the `goals` collection (when a db is given). */
async function persist(goals, { deps, file = path.join(__dirname, '..', '..', 'data', 'goals.json') } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(goals, null, 1));
  if (deps?.db) {
    const col = deps.db.col('goals');
    for (const g of goals) await col.updateOne({ id: g.id }, { $set: { ...g, updatedAt: new Date().toISOString() } }, { upsert: true });
  }
  return file;
}

module.exports = { SITE_ID, PERSONAS, templates, expand, splitFor, baseText, offlineText, composeGoals, paraphrase, toVerifySpec, persist };

if (require.main === module) {
  (async () => {
    const offline = process.argv.includes('--offline');
    let deps = null;
    if (!offline) {
      require('../lib/env');
      try { deps = await require('../lib').makeDeps(process.env); } catch (e) { console.error(`no real deps (${e.message}); falling back to --offline phrasings`); }
    }
    const goals = await composeGoals({ deps, offline: offline || !deps });
    const file = await persist(goals, { deps });
    const counts = goals.reduce((a, g) => { const k = g.flaw || (g.possible ? 'clean' : 'vague'); a[k] = (a[k] || 0) + 1; return a; }, {});
    console.log(JSON.stringify({ file, n: goals.length, counts, train: goals.filter((g) => g.split === 'train').length, heldout: goals.filter((g) => g.split === 'heldout').length, llm: !!deps && !offline }, null, 1));
    if (deps?.db?.close) await deps.db.close();
  })().catch((e) => { console.error(e); process.exit(1); });
}
