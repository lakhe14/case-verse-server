'use strict';

const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

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
  const url = process.env.DATABASE_URL;
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
    host = required('DB_HOST', '127.0.0.1');
    port = parseInt(process.env.DB_PORT || '3306', 10);
    name = required('DB_NAME', 'caseverse');
    user = required('DB_USER', 'root');
    password = process.env.DB_PASSWORD || '';
  }

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

const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  isProd: (process.env.NODE_ENV || 'development') === 'production',
  isTest: process.env.NODE_ENV === 'test',
  port: parseInt(process.env.PORT || '4000', 10),
  clientOrigin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',

  db: resolveDbConfig(),

  jwt: {
    accessSecret: required('JWT_ACCESS_SECRET'),
    refreshSecret: required('JWT_REFRESH_SECRET'),
    accessTtl: process.env.JWT_ACCESS_TTL || '15m',
    refreshTtl: process.env.JWT_REFRESH_TTL || '30d',
  },

  uploads: {
    dir: process.env.UPLOAD_DIR || 'uploads',
    maxMb: parseInt(process.env.MAX_UPLOAD_MB || '5', 10),
  },

  loyalty: {
    earnRate: parseFloat(process.env.LOYALTY_EARN_RATE || '0.02'),
    pointValue: parseFloat(process.env.LOYALTY_POINT_VALUE || '1'),
  },

  payment: {
    advanceAmount: parseFloat(process.env.PAYMENT_ADVANCE_AMOUNT || '100'),
    provider: process.env.PAYMENT_PROVIDER || 'eSewa',
  },
};

module.exports = env;
