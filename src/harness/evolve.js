'use strict';
/**
 * CLI: node src/harness/evolve.js --site trailhead --generations 3 [--no-train] [--max-ops 3]
 * Runs the self-improvement loop against real services; prints a JSON summary per generation and a final table.
 */
require('../lib/env');
const { makeDeps } = require('../lib');
const { evolve } = require('./editor');

function parseArgs(argv) {
  const out = { site: 'trailhead', generations: 3, train: true, maxOps: 3 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--site') out.site = argv[++i];
    else if (a === '--generations' || a === '-g') out.generations = Number(argv[++i]);
    else if (a === '--max-ops') out.maxOps = Number(argv[++i]);
    else if (a === '--no-train') out.train = false;
    else if (a === '--base') out.base = argv[++i];
    else if (a === '--concurrency') out.concurrency = Number(argv[++i]);
    else if (a === '--help' || a === '-h') { console.log('usage: node src/harness/evolve.js --site <id> --generations <n> [--no-train] [--max-ops <n>]'); process.exit(0); }
  }
  return out;
}

const fmt = (x) => (typeof x === 'number' ? (Number.isInteger(x) ? String(x) : x.toFixed(3)) : x == null ? '-' : String(x));
const pad = (s, n) => String(s).padEnd(n);

function printTable(results) {
  const head = ['gen', 'from', 'to', 'verdict', 'succ before', 'succ after', 'ms before', 'ms after', 'ops'];
  const rows = results.map((r, i) => [i + 1, r.from, r.to ?? '-', r.verdict, fmt(r.before?.successPossible), fmt(r.after?.successPossible), fmt(r.before?.medianMs), fmt(r.after?.medianMs), r.patch.length]);
  const widths = head.map((h, c) => Math.max(h.length, ...rows.map((r) => String(r[c]).length)));
  const line = (r) => r.map((v, c) => pad(v, widths[c])).join(' | ');
  console.log('\n' + line(head)); console.log(widths.map((w) => '-'.repeat(w)).join('-+-'));
  for (const r of rows) console.log(line(r));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const deps = await makeDeps(process.env);
  const { runSplit } = require('../sim/run'); // CONTRACTS §10: runSplit({ split, configVersion, deps }) -> metrics
  const baseUrl = args.base || process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
  const concurrency = Number(args.concurrency || process.env.SIM_CONCURRENCY || 4);
  const runGoals = (split, configVersion, opts = {}) => runSplit({ split, configVersion, deps, baseUrl, concurrency, ...opts });
  console.log(`evolve: site=${args.site} generations=${args.generations} base=${baseUrl} concurrency=${concurrency}`);
  const t0 = Date.now();
  try {
    const results = await evolve({
      siteId: args.site, generations: args.generations, deps, runGoals, trainFirst: args.train, maxOps: args.maxOps,
      onGeneration: (r, i) => console.log(JSON.stringify({ generation: i + 1, ...r })),
    });
    printTable(results);
    const active = results.filter((r) => r.verdict === 'kept').map((r) => r.to).pop() ?? results[0]?.from;
    console.log(`\nactive version: v${active}  generations: ${results.length}  kept: ${results.filter((r) => r.verdict === 'kept').length}  llm spend: $${(deps.llm.spentUsd() + (deps.llmStrong?.spentUsd?.() || 0)).toFixed(3)}  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } finally { await deps.db.close(); }
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = { parseArgs, printTable };
