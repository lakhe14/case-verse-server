'use strict';

/**
 * Initializes the isolated E2E database (caseverse_e2e by default):
 * creates it if missing, applies schema.sql to an empty database, runs the
 * idempotent migrations, seeds RBAC + fixture accounts + fixture catalog, and
 * removes stale E2E records left by an interrupted run.
 *
 * Usage (npm run e2e:db:setup):
 *   NODE_ENV=e2e E2E_ALLOW_DB_MUTATION=true node scripts/e2e/setup.js
 */

const { loadE2eEnv, SERVER_ROOT } = require('./loadEnv');

const MIGRATIONS = [
  'migratePaymentConfirmations.js',
  'migrateSalePricing.js',
  'migrateGuestCheckout.js',
  'migrateDashainCampaign.js',
  'migrateParcelMooverCourier.js',
  'migrateGuestOrderIdempotency.js',
  'migrateInventoryReservations.js',
  'migrateOrderCancellationReason.js',
  'migrateReviewHolds.js',
  'migrateCouponUsageRelease.js',
];

function connectionOptions(url, withDatabase) {
  const u = new URL(url);
  const options = {
    host: decodeURIComponent(u.hostname),
    port: Number(u.port || 3306),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    multipleStatements: true,
  };
  if (withDatabase) options.database = decodeURIComponent(u.pathname.replace(/^\//, ''));
  return options;
}

async function ensureDatabase(databaseName) {
  const fs = require('fs');
  const path = require('path');
  const mysql = require('mysql2/promise');
  const url = process.env.E2E_DATABASE_URL;
  const server = await mysql.createConnection(connectionOptions(url, false));
  try {
    // databaseName has passed assertE2eDatabaseName ([a-z0-9_]+_e2e), so it is safe to interpolate.
    await server.query(`CREATE DATABASE IF NOT EXISTS \`${databaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  } catch (error) {
    throw new Error(
      `Could not create ${databaseName} (${error.code || 'error'}). Ask a MySQL admin to run once:\n`
      + `  CREATE DATABASE \`${databaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;\n`
      + '  GRANT ALL PRIVILEGES ON `' + databaseName + '`.* TO \'<e2e user>\'@\'localhost\';'
    );
  } finally {
    await server.end();
  }
  const conn = await mysql.createConnection(connectionOptions(url, true));
  try {
    const [[{ name }]] = await conn.query('SELECT DATABASE() AS name');
    if (name !== databaseName) throw new Error('Connected to an unexpected database; aborting.');
    const [tables] = await conn.query('SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ?', [databaseName]);
    if (tables[0].n === 0) {
      await conn.query(fs.readFileSync(path.resolve(SERVER_ROOT, 'db', 'schema.sql'), 'utf8'));
      return 'schema applied';
    }
    return 'schema already present';
  } finally {
    await conn.end();
  }
}

function runMigrations() {
  const { spawnSync } = require('child_process');
  const path = require('path');
  for (const script of MIGRATIONS) {
    // Children inherit the verified E2E environment and re-run the guard in config/env.js.
    const result = spawnSync(process.execPath, [path.join(SERVER_ROOT, 'scripts', script)], { env: process.env, stdio: ['ignore', 'ignore', 'inherit'] });
    if (result.status !== 0) throw new Error(`Migration ${script} failed`);
  }
}

async function main() {
  const { databaseName, proofDir, runId } = loadE2eEnv({ mutation: true });
  console.info(`E2E setup | database: ${databaseName} | run: ${runId}`);
  console.info(`E2E setup | ${await ensureDatabase(databaseName)}`);
  runMigrations();
  console.info(`E2E setup | ${MIGRATIONS.length} migrations applied`);

  const db = require('../../models');
  db.sequelize.options.logging = false;
  const fixtures = require('./fixtures');
  try {
    const seeded = await fixtures.seedAll();
    const stale = await fixtures.cleanup();
    const state = await fixtures.verify();
    console.info(`E2E setup | accounts: ${seeded.accounts.join(', ')}`);
    console.info(`E2E setup | catalog: ${seeded.catalog.products} products, ${seeded.catalog.variants} variants`);
    console.info(`E2E setup | stale records removed: ${JSON.stringify(stale)}`);
    console.info(`E2E setup | state: ${JSON.stringify(state)}`);
    console.info(`E2E setup | proof dir: ${require('path').relative(SERVER_ROOT, proofDir)}`);
    if (!fixtures.isClean(state)) throw new Error('Fixture state is not clean after setup');
  } finally {
    await db.sequelize.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = { main };
