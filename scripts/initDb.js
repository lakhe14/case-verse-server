'use strict';

/**
 * Creates the target database (if the account may) and runs schema.sql.
 * Usage: node scripts/initDb.js
 *
 * Works against a local server or a managed one (Aiven/RDS/etc). schema.sql is
 * the source of truth for table structure; Sequelize models map onto it.
 *
 * Pass --drop to drop and recreate the database first (local dev reset). Managed
 * providers often forbid DROP/CREATE DATABASE — in that case the script keeps
 * going and just (re)applies the schema into the existing database.
 */

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const env = require('../config/env');

const SCHEMA_PATH = path.resolve(__dirname, '..', 'db', 'schema.sql');
const DROP = process.argv.includes('--drop');

function connectOptions(withDatabase) {
  const opts = {
    host: env.db.host,
    port: env.db.port,
    user: env.db.user,
    password: env.db.password,
    multipleStatements: true,
  };
  if (withDatabase) opts.database = env.db.name;
  if (env.db.ssl) {
    opts.ssl = { minVersion: 'TLSv1.2', rejectUnauthorized: env.db.sslRejectUnauthorized };
    if (env.db.sslCa) opts.ssl.ca = env.db.sslCa;
  }
  return opts;
}

async function main() {
  if (DROP && env.isProd) throw new Error('initDb --drop is disabled in production.');
  const sql = fs.readFileSync(SCHEMA_PATH, 'utf8');
  const name = env.db.name;

  // Phase 1: try to (re)create the database. Tolerate a lack of privilege.
  let serverConn;
  try {
    serverConn = await mysql.createConnection(connectOptions(false));
    if (DROP) {
      console.info(`Dropping database \`${name}\`...`);
      await serverConn.query(`DROP DATABASE IF EXISTS \`${name}\``);
    }
    await serverConn.query(
      `CREATE DATABASE IF NOT EXISTS \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
    console.info(`Database \`${name}\` is ready.`);
  } catch (err) {
    console.warn(
      `Could not create/drop \`${name}\` (${err.code || err.message}). ` +
        'Assuming it already exists and continuing.'
    );
  } finally {
    if (serverConn) await serverConn.end();
  }

  // Phase 2: apply the schema inside the target database.
  const conn = await mysql.createConnection(connectOptions(true));

  if (DROP) {
    // Table-level reset for providers that forbid DROP DATABASE (managed MySQL).
    const [tables] = await conn.query(
      'SELECT table_name AS t FROM information_schema.tables WHERE table_schema = ?',
      [name]
    );
    if (tables.length) {
      console.info(`Dropping ${tables.length} existing table(s)...`);
      await conn.query('SET FOREIGN_KEY_CHECKS = 0');
      for (const { t } of tables) await conn.query(`DROP TABLE IF EXISTS \`${t}\``);
      await conn.query('SET FOREIGN_KEY_CHECKS = 1');
    }
  }

  console.info('Running schema.sql...');
  await conn.query(sql);
  console.info('Schema applied.');
  await conn.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
