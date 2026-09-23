'use strict';

/**
 * Positive allow-list checks for the isolated E2E environment. Everything that
 * mutates E2E data (setup, cleanup, reset, the E2E server itself) calls these
 * before it opens a database connection. A failed check throws, so callers
 * abort before any query runs.
 */

const path = require('path');

const E2E_NODE_ENV = 'e2e';
const E2E_DB_NAME_PATTERN = /^[a-z0-9_]+_e2e$/;
// Belt and braces: names that must never be accepted even if renamed with a suffix check bug.
const FORBIDDEN_DB_NAMES = new Set(['caseverse', 'caseverse_db']);
const E2E_TMP_ROOT = path.resolve(__dirname, '..', '.tmp');

class E2eSafetyError extends Error {
  constructor(message) {
    super(`E2E SAFETY GUARD: ${message}`);
    this.name = 'E2eSafetyError';
  }
}

function databaseNameFromUrl(url) {
  if (!url) throw new E2eSafetyError('E2E_DATABASE_URL is not set.');
  let parsed;
  try {
    parsed = new URL(url);
  } catch (_) {
    throw new E2eSafetyError('E2E_DATABASE_URL is not a valid URL.');
  }
  return decodeURIComponent(parsed.pathname.replace(/^\//, ''));
}

function assertE2eDatabaseName(name) {
  if (!name || !E2E_DB_NAME_PATTERN.test(name) || FORBIDDEN_DB_NAMES.has(name)) {
    throw new E2eSafetyError(`refusing database "${name || '(none)'}": the name must end with "_e2e".`);
  }
  return name;
}

/** Resolved dir must sit strictly inside server/.tmp, never the real private-uploads tree. */
function assertE2eDirectory(dir, label = 'directory') {
  if (!dir) throw new E2eSafetyError(`${label} is not set.`);
  const resolved = path.resolve(dir);
  const relative = path.relative(E2E_TMP_ROOT, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new E2eSafetyError(`${label} must be inside server/.tmp (got a path outside it).`);
  }
  return resolved;
}

/**
 * Full check for E2E processes. `mutation: true` additionally requires the
 * explicit E2E_ALLOW_DB_MUTATION=true opt-in used by setup/cleanup/reset.
 */
function assertE2eEnvironment(source = process.env, { mutation = false } = {}) {
  if (source.NODE_ENV !== E2E_NODE_ENV) {
    throw new E2eSafetyError(`NODE_ENV must be exactly "${E2E_NODE_ENV}" (got "${source.NODE_ENV || '(unset)'}").`);
  }
  const name = assertE2eDatabaseName(databaseNameFromUrl(source.E2E_DATABASE_URL));
  if (source.DATABASE_URL && source.E2E_DATABASE_URL === source.DATABASE_URL) {
    throw new E2eSafetyError('E2E_DATABASE_URL must differ from DATABASE_URL.');
  }
  if (mutation && source.E2E_ALLOW_DB_MUTATION !== 'true') {
    throw new E2eSafetyError('E2E_ALLOW_DB_MUTATION=true is required for fixture setup or cleanup.');
  }
  return { databaseName: name };
}

module.exports = {
  E2E_NODE_ENV,
  E2E_TMP_ROOT,
  E2eSafetyError,
  databaseNameFromUrl,
  assertE2eDatabaseName,
  assertE2eDirectory,
  assertE2eEnvironment,
};
