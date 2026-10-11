'use strict';
// Wipe one site's memory (configs, maps, recipes, visits, runs) for a clean benchmark. Usage: node scripts/reset-site.js --site trailhead
require('../src/lib/env');
const { makeDeps } = require('../src/lib');
(async () => {
  const site = (process.argv.indexOf('--site') >= 0 ? process.argv[process.argv.indexOf('--site') + 1] : null) || 'trailhead';
  const deps = await makeDeps(process.env);
  for (const c of ['harness_configs', 'site_maps', 'recipes', 'visits', 'runs']) {
    const r = await deps.db.col(c).deleteMany({ siteId: site });
    console.log(`${c}: deleted ${r.deletedCount}`);
  }
  await deps.db.close();
})().catch((e) => { console.error(e); process.exit(1); });
