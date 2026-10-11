'use strict';
/**
 * OpenAI-compatible chat client (Neon AI Gateway) with a token budget, spend meter and 429 backoff + a fake.
 * chat(messages, { json, maxTokens, tag }) -> { text, usage, ms }
 */
const PRICES = { // USD per 1M tokens [input, output]; provider list prices
  'gpt-5-4-mini': [0.75, 4.5], 'gpt-5-mini': [0.25, 2], 'gpt-5-4-nano': [0.2, 1.25], 'claude-sonnet-5': [2, 10], 'claude-haiku-4-5': [1, 5], 'gemini-3-5-flash': [1.5, 9], 'gemini-3-flash': [0.5, 3],
};

function makeLlm({ baseUrl, token, model = 'gpt-5-4-mini', fetch = globalThis.fetch, budget = {}, log = () => {} } = {}) {
  if (!baseUrl || !token) throw new Error('makeLlm: baseUrl and token required');
  const base = baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '') + '/v1';
  const maxUsd = budget.maxUsd ?? 15, tpm = budget.tokensPerMinute ?? 150000;
  let spent = 0, calls = 0; const window = []; // [ts, tokens]
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function reserve(estTokens) {
    for (;;) {
      const now = Date.now(); while (window.length && now - window[0][0] > 60000) window.shift();
      const used = window.reduce((a, w) => a + w[1], 0);
      if (used + estTokens <= tpm) { window.push([now, estTokens]); return; }
      await sleep(1000);
    }
  }
  return {
    name: 'neon', model,
    spentUsd: () => spent, calls: () => calls,
    async chat(messages, { json = false, maxTokens = 800, tag = '', temperature } = {}) {
      if (spent >= maxUsd) throw new Error(`llm budget exhausted ($${spent.toFixed(2)} >= $${maxUsd})`);
      const est = Math.ceil(JSON.stringify(messages).length / 4) + maxTokens;
      await reserve(est);
      const body = { model, messages, max_tokens: maxTokens };
      if (json) body.response_format = { type: 'json_object' };
      if (temperature != null) body.temperature = temperature;
      if (/^gpt-5/.test(model)) body.reasoning_effort = 'minimal';
      for (let attempt = 0; attempt < 5; attempt++) {
        const t0 = Date.now();
        const res = await fetch(`${base}/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
        if (res.status === 429 || res.status === 503 || res.status === 529) {
          const ra = Number(res.headers.get?.('retry-after')) || Math.min(30, 2 ** attempt * 2);
          log('llm-backoff', { status: res.status, waitS: ra, tag }); await sleep(ra * 1000); continue;
        }
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(`llm ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
        const usage = data.usage || {}; const [pi, po] = PRICES[model] || [1, 5];
        const cost = ((usage.prompt_tokens || 0) * pi + (usage.completion_tokens || 0) * po) / 1e6;
        spent += cost; calls++;
        const ms = Date.now() - t0; log('llm', { tag, ms, usage, costUsd: +cost.toFixed(5), spentUsd: +spent.toFixed(4) });
        return { text: data.choices?.[0]?.message?.content ?? '', usage, ms, costUsd: cost };
      }
      throw new Error('llm: gave up after retries');
    },
  };
}

/** Fake LLM: handlers keyed by `tag` (or 'default'); each (messages, opts) -> string|object. */
function makeFakeLlm(handlers = {}) {
  let calls = 0;
  return {
    name: 'fake-llm', model: 'fake', calls: () => calls, spentUsd: () => 0,
    async chat(messages, opts = {}) {
      calls++;
      const h = handlers[opts.tag] || handlers.default || (() => '{}');
      const out = await h(messages, opts);
      return { text: typeof out === 'string' ? out : JSON.stringify(out), usage: { prompt_tokens: 100, completion_tokens: 50 }, ms: 1, costUsd: 0 };
    },
  };
}

function parseJson(text) {
  try { return JSON.parse(text); } catch {}
  const m = String(text).match(/\{[\s\S]*\}|\[[\s\S]*\]/); if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

module.exports = { makeLlm, makeFakeLlm, parseJson, PRICES };
