'use strict';
/**
 * Jev (TypeSafe AI "System One" model) client + a deterministic fake for tests.
 * Interface: { decide(state, questions) -> { answers, usage, ms } }
 *   questions: { id: {type:'choice', instructions, criteria:{opt: desc|null}} | {type:'noul', instructions} | {type:'score', instructions, criteria:[]} }
 *   answers:   choice -> { choice, probabilities, confidence } ; noul -> { noul } ; score -> { score, confidence }
 */

function makeJev({ apiKey, url = 'https://api.typesafe.ai/v1/systemone', model = 'jev-latest', fetch = globalThis.fetch, timeoutMs = 8000, log = () => {} } = {}) {
  if (!apiKey) throw new Error('makeJev: apiKey required');
  return {
    name: 'jev',
    async decide(state, questions) {
      const t0 = Date.now();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          method: 'POST', signal: ctrl.signal,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model, state, questions }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(`jev ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
        const ms = Date.now() - t0;
        log('jev', { ms, usage: body.usage });
        return { answers: body.answers || {}, usage: body.usage || {}, ms, model: body.model };
      } finally { clearTimeout(timer); }
    },
  };
}

// ---------- fake: a heuristic oracle, deterministic, never throws ----------
const STOP = new Set('the a an to of in on for with and or my me i want need please get it this that is are be at by from into under over below above max min least most'.split(' '));
const tokens = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9$%★.\s]/g, ' ').split(/\s+/).filter((t) => t && !STOP.has(t));
function overlap(a, b) { const A = new Set(tokens(a)); let n = 0; for (const t of tokens(b)) if (A.has(t)) n++; return n; }

function makeFakeJev({ latencyMs = 0 } = {}) {
  const calls = [];
  return {
    name: 'fake-jev',
    calls,
    async decide(state, questions) {
      const t0 = Date.now();
      const answers = {};
      const goal = typeof state === 'string' ? state : JSON.stringify(state.goal || state);
      const stateText = typeof state === 'string' ? state : JSON.stringify(state);
      for (const [id, q] of Object.entries(questions || {})) {
        if (q.type === 'choice') {
          const opts = Object.keys(q.criteria || {});
          const scores = opts.map((o) => 1 + overlap(goal + ' ' + (q.instructions || ''), o + ' ' + (q.criteria[o] || '')) * 3 + overlap(stateText, o));
          const sum = scores.reduce((a, b) => a + b, 0) || 1;
          const probabilities = Object.fromEntries(opts.map((o, i) => [o, scores[i] / sum]));
          const best = opts.reduce((b, o) => (probabilities[o] > probabilities[b] ? o : b), opts[0]);
          const sorted = Object.values(probabilities).sort((a, b) => b - a);
          answers[id] = { choice: best, probabilities, confidence: Math.min(0.99, (sorted[0] || 0) - (sorted[1] || 0) + 0.5) };
        } else if (q.type === 'noul') {
          // Generic vocabulary only. Feasibility/satisfaction look at page *messages* (alerts/status), not the whole state.
          const ins = (q.instructions || '').toLowerCase();
          const msgs = (typeof state === 'object' && Array.isArray(state.messages) ? state.messages.map((m) => (typeof m === 'string' ? m : m.text || '')).join(' ') : '').toLowerCase();
          const after = (typeof state === 'object' && Array.isArray(state.history) ? state.history.flatMap((h) => h.messagesAfter || []).join(' ') : '').toLowerCase();
          const bad = /out of stock|unavailable|invalid|sign in|log in|not found|no results|no products|no items|error|not offered|adult sizes only/;
          const good = /added|placed|thank you|confirmed|booked|success|status:|order #/;
          let p = 0.5;
          if (/satisf|achiev|complete|done|success/.test(ins)) p = good.test(msgs + ' ' + after) ? 0.9 : bad.test(msgs) ? 0.1 : 0.4;
          else if (/possible|feasib|can this/.test(ins)) p = bad.test(msgs) ? 0.15 : 0.85;
          else if (/confirm|irreversible|money|pay|order|purchase|submit/.test(ins)) p = /pay|place order|submit|book|checkout/.test(stateText.toLowerCase()) ? 0.7 : 0.1;
          answers[id] = { noul: p };
        } else if (q.type === 'score') {
          const n = (q.criteria || []).length || 2;
          answers[id] = { score: (n - 1) / 2, confidence: 0.6 };
        }
      }
      calls.push({ state, questions, answers });
      if (latencyMs) await new Promise((r) => setTimeout(r, latencyMs));
      return { answers, usage: { input_tokens: Math.ceil(stateText.length / 4), output_tokens: 0 }, ms: Date.now() - t0 + latencyMs, model: 'fake' };
    },
  };
}

module.exports = { makeJev, makeFakeJev, tokens };
