'use strict';

/**
 * Removes only E2E fixture data from the isolated E2E database: orders owned
 * by fixture customers or tagged E2E guest orders (and their payment
 * confirmations, items, history, tokens), fixture carts/wishlists/extra
 * addresses, proof files in the E2E proof directory; then restores fixture
 * stock exactly. Fixture accounts and catalog stay.
 *
 * Usage (npm run e2e:db:cleanup):
 *   NODE_ENV=e2e E2E_ALLOW_DB_MUTATION=true node scripts/e2e/cleanup.js [--run-id=E2E-...] [--verify]
 * --verify exits non-zero unless the post-cleanup state is fully clean.
 */

const { loadE2eEnv } = require('./loadEnv');

async function main() {
  // The guard runs here, before models (and therefore any DB connection) load.
  const { databaseName } = loadE2eEnv({ mutation: true });
  const runArg = process.argv.find((arg) => arg.startsWith('--run-id='));
  const runId = runArg ? runArg.slice('--run-id='.length) : undefined;
  if (runId && !/^E2E-[A-Za-z0-9-]+$/.test(runId)) throw new Error('Invalid --run-id');

  const db = require('../../models');
  db.sequelize.options.logging = false;
  const fixtures = require('./fixtures');
  try {
    const removed = await fixtures.cleanup({ runId });
    const state = await fixtures.verify();
    console.info(`E2E cleanup | database: ${databaseName}${runId ? ` | run: ${runId}` : ''}`);
    console.info(`E2E cleanup | removed: ${JSON.stringify(removed)}`);
    console.info(`E2E cleanup | state: ${JSON.stringify(state)}`);
    if (process.argv.includes('--verify') && !fixtures.isClean(state)) {
      throw new Error('E2E post-cleanup verification failed');
    }
  } finally {
    await db.sequelize.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
