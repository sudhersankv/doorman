'use strict';
// Removes harness config versions above --keep (default 1) and their benchmark runs for a site, re-activating the kept
// version. Used to discard a broken evolution run (e.g. benchmarks that errored out) before re-running it.
//   node scripts/prune-versions.js --site trailhead --keep 1
require('../src/lib/env');
const { makeDeps } = require('../src/lib');
const args = process.argv.slice(2); const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
(async () => {
  const site = arg('--site', 'trailhead'), keep = Number(arg('--keep', 1));
  const deps = await makeDeps(process.env);
  const c = await deps.db.col('harness_configs').deleteMany({ siteId: site, version: { $gt: keep } });
  const r = await deps.db.col('runs').deleteMany({ siteId: site, configVersion: { $gt: keep } });
  await deps.db.col('harness_configs').updateOne({ siteId: site, version: keep }, { $set: { active: true } });
  console.log(`site ${site}: removed ${c.deletedCount} config versions > ${keep}, ${r.deletedCount} runs; v${keep} active`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
