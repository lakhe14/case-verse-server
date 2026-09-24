'use strict';

const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');

const { assertE2eEnvironment, assertE2eDirectory, E2E_TMP_ROOT } = require('./e2eGuard');

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const isE2e = process.env.NODE_ENV === 'e2e';
// The isolated E2E environment never inherits DATABASE_URL: it must name an
// *_e2e database explicitly, or the process refuses to start.
if (isE2e) assertE2eEnvironment(process.env);

function required(key, fallback) {
  const value = process.env[key] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

/**
 * Resolve the database config from either a single DATABASE_URL
 * (e.g. mysql://user:pass@host:port/db?ssl-mode=REQUIRED) or discrete DB_* vars.
 * A URL wins when present.
 */
function resolveDbConfig() {
  const isTest = process.env.NODE_ENV === 'test';
  // Integration tests must opt into a dedicated test database. Never inherit
  // DATABASE_URL/DB_NAME from development when NODE_ENV=test.
  if (isTest && !process.env.DB_TEST_NAME) {
    throw new Error('NODE_ENV=test requires DB_TEST_NAME (a dedicated test database)');
  }
  const url = isTest ? process.env.DB_TEST_URL : isE2e ? process.env.E2E_DATABASE_URL : process.env.DATABASE_URL;
  let host, port, name, user, password;
  let sslFromUrl = false;

  if (url) {
    const u = new URL(url);
    host = decodeURIComponent(u.hostname);
    port = parseInt(u.port || '3306', 10);
    name = decodeURIComponent(u.pathname.replace(/^\//, '')) || 'defaultdb';
    user = decodeURIComponent(u.username);
    password = decodeURIComponent(u.password);
    const sslMode = (u.searchParams.get('ssl-mode') || u.searchParams.get('sslmode') || '').toUpperCase();
    sslFromUrl = ['REQUIRED', 'VERIFY_CA', 'VERIFY_IDENTITY', 'TRUE', '1'].includes(sslMode);
  } else {
    host = isTest ? required('DB_TEST_HOST', '127.0.0.1') : required('DB_HOST', '127.0.0.1');
    port = parseInt((isTest ? process.env.DB_TEST_PORT : process.env.DB_PORT) || '3306', 10);
    name = isTest ? required('DB_TEST_NAME') : required('DB_NAME', 'caseverse');
    user = isTest ? required('DB_TEST_USER', 'root') : required('DB_USER', 'root');
    password = isTest ? (process.env.DB_TEST_PASSWORD || '') : (process.env.DB_PASSWORD || '');
  }

  if (isTest && !/test/i.test(name)) throw new Error('Refusing test database configuration without "test" in its name');

  // SSL: on if the URL asked for it, or DB_SSL=true, or the host looks managed.
  const sslEnv = (process.env.DB_SSL || '').toLowerCase();
  const ssl =
    sslEnv === 'true' ||
    sslEnv === '1' ||
    sslFromUrl ||
    (sslEnv !== 'false' && /\b(aivencloud|rds\.amazonaws|azure|planetscale|neon)\b/.test(host));

  let ca;
  if (process.env.DB_CA_CERT) {
    // Value may be a file path or the PEM text itself.
    ca = fs.existsSync(process.env.DB_CA_CERT)
      ? fs.readFileSync(process.env.DB_CA_CERT, 'utf8')
      : process.env.DB_CA_CERT;
  }

  return {
    host,
    port,
    name,
    user,
    password,
    ssl,
    // Verify the server cert only when a CA is supplied; otherwise encrypt without
    // verification (managed providers use private CAs not in Node's trust store).
    sslRejectUnauthorized: ca ? true : process.env.DB_SSL_REJECT_UNAUTHORIZED === 'true',
    sslCa: ca,
  };
}

/**
 * Optional Redis read cache (services/cache.service.js). Off unless a Redis URL
 * is configured; the app never requires Redis. Unit tests never use one, and
 * the E2E environment only uses E2E_REDIS_URL (never the dev REDIS_URL) with
 * its own key prefix, so E2E data can never land in the development cache.
 */
function resolveCacheConfig() {
  const url = isE2e ? process.env.E2E_REDIS_URL : process.env.NODE_ENV === 'test' ? undefined : process.env.REDIS_URL;
  const flag = String(process.env.CACHE_ENABLED ?? 'true').toLowerCase() !== 'false';
  const int = (value, fallback, min, max) => {
    const n = parseInt(value, 10);
    return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
  };
  const prefix = String(process.env.CACHE_PREFIX || 'caseverse').replace(/[^A-Za-z0-9_-]/g, '') || 'caseverse';
  return {
    enabled: Boolean(url) && flag,
    url: url || null,
    prefix: isE2e ? `${prefix}-e2e` : prefix,
    defaultTtlSeconds: int(process.env.CACHE_DEFAULT_TTL_SECONDS, 300, 5, 3600),
    negativeTtlSeconds: int(process.env.CACHE_NEGATIVE_TTL_SECONDS, 45, 5, 300),
    // A dead or slow Redis must never make a page wait: fail fast, use MySQL.
    connectTimeoutMs: 1000,
    commandTimeoutMs: 150,
  };
}

const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  isProd: (process.env.NODE_ENV || 'development') === 'production',
  isTest: process.env.NODE_ENV === 'test',
  isE2e,
  port: parseInt(process.env.PORT || '4000', 10),
  clientOrigin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',

  db: resolveDbConfig(),

  cache: resolveCacheConfig(),

  jwt: {
    accessSecret: required('JWT_ACCESS_SECRET'),
    refreshSecret: required('JWT_REFRESH_SECRET'),
    accessTtl: process.env.JWT_ACCESS_TTL || '15m',
    refreshTtl: process.env.JWT_REFRESH_TTL || '30d',
  },

  uploads: {
    dir: isE2e ? assertE2eDirectory(path.resolve(__dirname, '..', process.env.UPLOAD_DIR || '.tmp/e2e-uploads'), 'UPLOAD_DIR') : process.env.UPLOAD_DIR || 'uploads',
    maxMb: parseInt(process.env.MAX_UPLOAD_MB || '5', 10),
    // Private payment proofs. E2E runs are confined to server/.tmp so they can
    // never read, write or delete files in the real private-uploads tree.
    proofDir: isE2e
      ? assertE2eDirectory(path.resolve(__dirname, '..', process.env.PRIVATE_UPLOAD_DIR || path.join(E2E_TMP_ROOT, 'e2e-payment-proofs')), 'PRIVATE_UPLOAD_DIR')
      : path.resolve(__dirname, '..', 'private-uploads', 'payment-proofs'),
  },

  // Deterministic, test-only ParcelMoover responses. Only honoured in the
  // isolated E2E environment; every other environment calls the real provider.
  parcelmooverStub: isE2e && process.env.PARCELMOOVER_MODE === 'e2e-stub',

  loyalty: {
    earnRate: parseFloat(process.env.LOYALTY_EARN_RATE || '0.02'),
    pointValue: parseFloat(process.env.LOYALTY_POINT_VALUE || '1'),
  },

  // Seals guest tokens for idempotent replay (see services/guestIdempotency.js).
  // A dedicated secret is preferred; the refresh secret is the fallback.
  guestReplaySecret: process.env.GUEST_REPLAY_SECRET || process.env.JWT_REFRESH_SECRET,

  payment: {
    advanceAmount: parseFloat(process.env.PAYMENT_ADVANCE_AMOUNT || '100'),
    provider: process.env.PAYMENT_PROVIDER || 'eSewa',
  },
};

module.exports = env;
