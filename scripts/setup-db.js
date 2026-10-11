'use strict';
/** Create collections, plain indexes and Atlas vector indexes, then wait until the vector indexes are queryable. */
require('../src/lib/env');
const { makeDeps } = require('../src/lib');

async function main() {
  const t0 = Date.now();
  const deps = await makeDeps(process.env);
  try {
    await deps.db.ensureIndexes();
    console.log(`indexes ensured (${Date.now() - t0} ms); waiting for vector indexes to become queryable...`);
    await deps.db.waitForIndexes();
    console.log(`OK  db=${process.env.MONGODB_DB || 'doorman'} (${Date.now() - t0} ms)`);
  } finally { await deps.db.close(); }
}

main().catch((e) => { console.error('FAILED', e.message || e); process.exit(1); });
