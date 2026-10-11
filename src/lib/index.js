'use strict';
/** Build the `deps` object every harness module takes. Real from env, or fakes for tests. */
const { makeJev, makeFakeJev } = require('./jev');
const { makeEmbed, makeFakeEmbed } = require('./embeddings');
const { makeLlm, makeFakeLlm } = require('./llm');
const { makeDb, makeFakeDb } = require('./db');

function makeLog(verbose = !!process.env.DOORMAN_VERBOSE) {
  return (event, data) => { if (verbose) console.log(`[${new Date().toISOString().slice(11, 19)}] ${event} ${data ? JSON.stringify(data) : ''}`); };
}

async function makeDeps(env = process.env, { log = makeLog() } = {}) {
  const need = (k) => { const v = (env[k] || '').trim(); if (!v) throw new Error(`missing ${k} in .env`); return v; };
  const dims = Number(env.VOYAGE_DIMS || 1024);
  const db = await makeDb({ uri: need('MONGODB_URI'), dbName: env.MONGODB_DB || 'doorman', dims, log });
  return {
    db, log,
    jev: makeJev({ apiKey: need('JEV_API_KEY'), url: env.JEV_API_URL, model: env.JEV_MODEL, log }),
    embed: makeEmbed({ apiKey: need('VOYAGE_API_KEY'), baseUrl: env.VOYAGE_BASE_URL, model: env.VOYAGE_MODEL, dims, log }),
    llm: makeLlm({ baseUrl: need('NEON_AI_GATEWAY_BASE_URL'), token: need('NEON_AI_GATEWAY_TOKEN'), model: env.NEON_MODEL || 'gpt-5-4-mini', log, budget: { maxUsd: Number(env.LLM_MAX_USD || 15) } }),
    llmStrong: makeLlm({ baseUrl: need('NEON_AI_GATEWAY_BASE_URL'), token: need('NEON_AI_GATEWAY_TOKEN'), model: env.NEON_STRONG_MODEL || 'claude-sonnet-5', log, budget: { maxUsd: 3 } }),
  };
}

function makeFakeDeps({ llmHandlers = {}, dims = 64, jevLatencyMs = 0 } = {}) {
  const llm = makeFakeLlm(llmHandlers);
  return { db: makeFakeDb(), jev: makeFakeJev({ latencyMs: jevLatencyMs }), embed: makeFakeEmbed(dims), llm, llmStrong: llm, log: () => {} };
}

module.exports = { makeDeps, makeFakeDeps, makeLog };
