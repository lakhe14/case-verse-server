'use strict';

/**
 * Server-side error logging that is safe to ship to a log provider.
 *
 * Outside development a record carries only structured, non-identifying
 * fields: request id, time, method, redacted path, status, a category, the
 * error class and a driver/system error code (e.g. ER_DUP_ENTRY). Never the
 * error message (Sequelize/MySQL messages embed SQL, bind values and
 * constraint names), never a stack, body, header, token or customer data.
 *
 * Development additionally logs message and stack, with credentials and
 * tokens redacted, so local debugging stays practical.
 */

const env = require('../config/env');

// Guest access tokens travel in URL paths; query strings may carry search text.
const redactPath = (url = '') => url
  .split('?')[0]
  .replace(/(\/api\/guest-checkout\/orders\/)[^/]+/g, '$1<redacted>')
  .replace(/(\/order\/guest\/)[^/]+/g, '$1<redacted>');

const SAFE_CODE = /^(ER_[A-Z0-9_]+|E[A-Z0-9_]+|PROTOCOL_[A-Z_]+)$/;

/** Maps any thrown value to a category and a code that contain no data. */
function classifyError(error) {
  const name = typeof error?.name === 'string' && /^[A-Za-z]+$/.test(error.name) ? error.name : 'Error';
  const rawCode = error?.parent?.code || error?.original?.code || error?.code;
  const code = typeof rawCode === 'string' && SAFE_CODE.test(rawCode) ? rawCode : null;
  let category = 'unexpected_error';
  if (name === 'SequelizeUniqueConstraintError' || name === 'SequelizeForeignKeyConstraintError' || code === 'ER_DUP_ENTRY') category = 'constraint_conflict';
  else if (code === 'ER_LOCK_DEADLOCK' || code === 'ER_LOCK_WAIT_TIMEOUT') category = 'transaction_conflict';
  else if (name.startsWith('Sequelize') || (code && code.startsWith('ER_')) || ['ECONNREFUSED', 'ETIMEDOUT', 'PROTOCOL_CONNECTION_LOST'].includes(code)) category = 'database_error';
  return { category, error_class: name, code };
}

// Credentials and tokens that must not survive even in development output.
function redactSecrets(text = '') {
  return String(text)
    .replace(/(mysql|mysqls|postgres):\/\/[^\s'"@]*@/gi, '$1://<redacted>@')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer <redacted>')
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g, '<jwt>')
    .replace(/\b[a-f0-9]{40,}\b/gi, '<token>')
    .replace(/(token=)[^&\s]+/gi, '$1<redacted>')
    .replace(/(\/api\/guest-checkout\/orders\/)[^/\s?]+/g, '$1<redacted>');
}

function write(record, error) {
  const out = { level: 'error', time: new Date().toISOString(), ...record, ...classifyError(error) };
  if (env.nodeEnv === 'development' && error) {
    out.dev_message = redactSecrets(error.message);
    out.dev_stack = redactSecrets(error.stack);
  }
  console.error(JSON.stringify(out));
}

/** An HTTP request that ended in a 5xx. */
function logRequestError(req, status, error) {
  write({ event: 'http_error', request_id: req.requestId || null, method: req.method, path: redactPath(req.originalUrl), status }, error);
}

/** Startup, maintenance or process-level failures. */
function logProcessError(event, error) {
  write({ event }, error);
}

module.exports = { logRequestError, logProcessError, classifyError, redactPath, redactSecrets };
