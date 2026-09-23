'use strict';

/**
 * Prepares process.env for an isolated E2E process and runs the safety guard
 * BEFORE anything requires config/env.js or the models.
 *
 * NODE_ENV=e2e (and E2E_ALLOW_DB_MUTATION=true for setup/cleanup) must be set
 * explicitly by the caller (npm scripts do). This loader never sets them.
 *
 * Precedence: real environment > server/.env.e2e.local (gitignored) > derived
 * defaults. The default E2E database reuses the dev server's host and account
 * but always the fixed name `caseverse_e2e`; the guard still verifies it.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { assertE2eEnvironment, assertE2eDirectory, E2E_TMP_ROOT } = require('../../config/e2eGuard');

const SERVER_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_DB_NAME = 'caseverse_e2e';

function readDotenv(file) {
  return fs.existsSync(file) ? dotenv.parse(fs.readFileSync(file)) : {};
}

function setDefault(key, value) {
  if (process.env[key] === undefined || process.env[key] === '') process.env[key] = value;
}

function deriveE2eDatabaseUrl(devEnv) {
  if (!devEnv.DATABASE_URL) return undefined;
  const url = new URL(devEnv.DATABASE_URL);
  url.pathname = `/${DEFAULT_DB_NAME}`;
  return url.toString();
}

function newRunId() {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `E2E-${day}-${crypto.randomBytes(3).toString('hex')}`;
}

function loadE2eEnv({ mutation = false } = {}) {
  const devEnv = readDotenv(path.join(SERVER_ROOT, '.env'));
  const localEnv = readDotenv(path.join(SERVER_ROOT, '.env.e2e.local'));
  for (const [key, value] of Object.entries(localEnv)) setDefault(key, value);

  setDefault('E2E_DATABASE_URL', deriveE2eDatabaseUrl(devEnv));
  setDefault('PORT', '4010');
  setDefault('CLIENT_ORIGIN', 'http://localhost:5174,http://127.0.0.1:5174');
  setDefault('UPLOAD_DIR', path.join(E2E_TMP_ROOT, 'e2e-uploads'));
  setDefault('PRIVATE_UPLOAD_DIR', path.join(E2E_TMP_ROOT, 'e2e-payment-proofs'));
  setDefault('PARCELMOOVER_MODE', process.env.E2E_PARCELMOOVER_LIVE === 'true' ? 'live' : 'e2e-stub');
  setDefault('E2E_RUN_ID', newRunId());
  // Per-run secrets: an E2E token can never verify against the dev API.
  setDefault('JWT_ACCESS_SECRET', crypto.randomBytes(32).toString('hex'));
  setDefault('JWT_REFRESH_SECRET', crypto.randomBytes(32).toString('hex'));

  const { databaseName } = assertE2eEnvironment({ ...devEnv, ...process.env }, { mutation });
  const proofDir = assertE2eDirectory(path.resolve(SERVER_ROOT, process.env.PRIVATE_UPLOAD_DIR), 'PRIVATE_UPLOAD_DIR');
  const uploadDir = assertE2eDirectory(path.resolve(SERVER_ROOT, process.env.UPLOAD_DIR), 'UPLOAD_DIR');
  fs.mkdirSync(proofDir, { recursive: true });
  fs.mkdirSync(uploadDir, { recursive: true });
  return { databaseName, proofDir, uploadDir, runId: process.env.E2E_RUN_ID, port: Number(process.env.PORT) };
}

module.exports = { loadE2eEnv, newRunId, DEFAULT_DB_NAME, SERVER_ROOT };
