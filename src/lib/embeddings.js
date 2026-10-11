'use strict';
/** Voyage embeddings (via MongoDB's endpoint) + a deterministic fake. embed(texts, 'query'|'document') -> number[][] */

function makeEmbed({ apiKey, baseUrl = 'https://ai.mongodb.com/v1', model = 'voyage-4-lite', dims = 1024, fetch = globalThis.fetch, log = () => {} } = {}) {
  if (!apiKey) throw new Error('makeEmbed: apiKey required');
  const cache = new Map();
  return {
    name: 'voyage', dims,
    async embed(texts, inputType = 'query') {
      const list = Array.isArray(texts) ? texts : [texts];
      const out = new Array(list.length);
      const missing = [];
      list.forEach((t, i) => { const k = inputType + '\u0000' + t; if (cache.has(k)) out[i] = cache.get(k); else missing.push(i); });
      if (missing.length) {
        const t0 = Date.now();
        const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/embeddings`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ input: missing.map((i) => list[i]), model, input_type: inputType }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(`voyage ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
        body.data.forEach((d, j) => { const i = missing[j]; out[i] = d.embedding; cache.set(inputType + '\u0000' + list[i], d.embedding); });
        log('embed', { n: missing.length, ms: Date.now() - t0 });
      }
      return out;
    },
  };
}

// fake: hashed bag-of-words into `dims` buckets, L2-normalized. Shared tokens -> higher cosine. Deterministic.
function makeFakeEmbed(dims = 64) {
  const h = (s) => { let x = 2166136261; for (const c of s) { x ^= c.charCodeAt(0); x = Math.imul(x, 16777619) >>> 0; } return x; };
  return {
    name: 'fake-embed', dims,
    async embed(texts) {
      const list = Array.isArray(texts) ? texts : [texts];
      return list.map((t) => {
        const v = new Array(dims).fill(0);
        for (const tok of String(t).toLowerCase().split(/[^a-z0-9$]+/).filter(Boolean)) { v[h(tok) % dims] += 1; v[h(tok + '~') % dims] += 0.5; }
        const n = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
        return v.map((x) => x / n);
      });
    },
  };
}

function cosine(a, b) { let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return d / (Math.sqrt(na) * Math.sqrt(nb) || 1); }

module.exports = { makeEmbed, makeFakeEmbed, cosine };
