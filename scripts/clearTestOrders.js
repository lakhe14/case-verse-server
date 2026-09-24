'use strict';

/**
 * Removes test orders from the isolated E2E database ONLY.
 * Usage: npm run e2e:db:cleanup  (preferred), or
 *        NODE_ENV=e2e E2E_ALLOW_DB_MUTATION=true node scripts/clearTestOrders.js
 *
 * This script used to delete every order in whatever database .env pointed to
 * (the development database included) and to rewrite variant stock from a
 * JSON file under the old "deduct at placement" model, which is wrong now that
 * unpaid orders only reserve stock. It is kept only as an alias for the scoped
 * E2E cleanup: the positive E2E guard (NODE_ENV=e2e, a *_e2e database,
 * E2E_ALLOW_DB_MUTATION=true) runs before any model or database connection
 * loads, and anything else is refused. Fixture stock is restored by the E2E
 * cleanup after the fixture orders and their reservations are deleted.
 */

const path = require('path');
const { spawnSync } = require('child_process');
const { loadE2eEnv } = require('./e2e/loadEnv');

function main() {
  try {
    // Same guard as every E2E mutation script; throws before any DB access.
    loadE2eEnv({ mutation: true });
  } catch (error) {
    console.error(`${error.message}\nclearTestOrders only runs against the isolated E2E database; use npm run e2e:db:cleanup.`);
    return 1;
  }
  const result = spawnSync(process.execPath, [path.join(__dirname, 'e2e', 'cleanup.js'), '--verify'], { env: process.env, stdio: 'inherit' });
  return result.status ?? 1;
}

process.exitCode = main();
