'use strict';

/**
 * Brings the configured database up to date: applies db/schema.sql to an
 * empty database, then runs every migration in order (scripts/migrations.js).
 * Safe to run on every deploy: an existing schema is left alone and each
 * migration is idempotent. Never drops anything.
 * Usage: npm run db:migrate
 */

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const env = require('../config/env');
const { runMigrations } = require('./migrations');

async function applySchemaIfEmpty() {
  const options = { host: env.db.host, port: env.db.port, user: env.db.user, password: env.db.password, database: env.db.name, multipleStatements: true };
  if (env.db.ssl) options.ssl = { minVersion: 'TLSv1.2', rejectUnauthorized: env.db.sslRejectUnauthorized, ...(env.db.sslCa ? { ca: env.db.sslCa } : {}) };
  const conn = await mysql.createConnection(options);
  try {
    const [[{ n }]] = await conn.query('SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE()');
    if (Number(n) > 0) return 'schema already present';
    await conn.query(fs.readFileSync(path.resolve(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
    return 'schema applied to an empty database';
  } finally {
    await conn.end();
  }
}

async function main() {
  console.info(`Database: ${env.db.name}`);
  console.info(`Schema: ${await applySchemaIfEmpty()}`);
  console.info(`Migrations: ${runMigrations({ quiet: true })} applied (idempotent)`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
