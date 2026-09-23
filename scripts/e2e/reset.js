'use strict';

/**
 * Dedicated, explicit reset: drops the verified *_e2e database so the next
 * setup rebuilds it from schema.sql. Never touches any other database.
 *
 * Usage (npm run e2e:db:reset):
 *   NODE_ENV=e2e E2E_ALLOW_DB_MUTATION=true node scripts/e2e/reset.js --confirm-drop-e2e
 */

const { loadE2eEnv } = require('./loadEnv');
const { assertE2eDatabaseName } = require('../../config/e2eGuard');

async function main() {
  const { databaseName } = loadE2eEnv({ mutation: true });
  if (!process.argv.includes('--confirm-drop-e2e')) throw new Error('Pass --confirm-drop-e2e to drop the E2E database.');
  assertE2eDatabaseName(databaseName);
  const mysql = require('mysql2/promise');
  const u = new URL(process.env.E2E_DATABASE_URL);
  const conn = await mysql.createConnection({ host: decodeURIComponent(u.hostname), port: Number(u.port || 3306), user: decodeURIComponent(u.username), password: decodeURIComponent(u.password) });
  try {
    await conn.query(`DROP DATABASE IF EXISTS \`${databaseName}\``);
    console.info(`E2E reset | dropped ${databaseName}`);
  } finally {
    await conn.end();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
