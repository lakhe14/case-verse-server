'use strict';

const ApiError = require('../utils/ApiError');

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  let status = 500;
  let code = 'internal_error';
  let message = 'Something went wrong';
  let details;

  if (err instanceof ApiError) {
    status = err.status;
    code = err.code;
    message = err.message;
    details = err.details;
  } else if (err && err.name === 'SequelizeUniqueConstraintError') {
    status = 409;
    code = 'conflict';
    message = 'A record with those values already exists';
    details = err.errors?.map((e) => ({ path: e.path, message: e.message }));
  } else if (err && err.name === 'SequelizeForeignKeyConstraintError') {
    // Services pre-check references and return specific codes; this is the
    // fallback for a race. Never echo the constraint, table or SQL.
    status = 409;
    code = 'conflict';
    message = 'This record is referenced by other records and cannot be changed this way.';
  } else if (err && ['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'].includes(err.parent?.code || err.original?.code)) {
    // A concurrent checkout or review won the row lock; the whole transaction
    // rolled back, so retrying is safe. Never echo lock or SQL details.
    status = 409;
    code = 'retry_conflict';
    message = 'Another update was in progress. Please try again.';
  } else if (err && err.name === 'SequelizeValidationError') {
    status = 422;
    code = 'validation_failed';
    message = 'Validation failed';
    details = err.errors?.map((e) => ({ path: e.path, message: e.message }));
  } else if (err && (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError')) {
    status = 401;
    code = 'invalid_token';
    message = 'Invalid or expired token';
  } else if (err && err.type === 'entity.parse.failed') {
    status = 400;
    code = 'invalid_json';
    message = 'Request body is not valid JSON';
  } else if (err && err.name === 'MulterError') {
    status = 400;
    code = err.code === 'LIMIT_FILE_SIZE' ? 'payment_proof_too_large' : 'invalid_payment_proof';
    message = err.code === 'LIMIT_FILE_SIZE'
      ? 'Payment proof must be 5 MB or smaller.'
      : 'Upload one JPG, PNG, or WebP payment proof.';
  }

  if (status >= 500) {
    // Keep diagnostics server-side and avoid serializing an Error object that
    // may contain driver/upstream details or a guest token in its request URL.
    const safeUrl = (req.originalUrl || '').replace(/(\/api\/guest-checkout\/orders\/)[^/?]+/g, '$1<redacted>');
    console.error({ requestId: req.requestId, method: req.method, url: safeUrl, error: err?.name, message: err?.message, stack: err?.stack });
  }

  const payload = { error: { message, code, request_id: req.requestId } };
  if (details) payload.error.details = details;

  res.status(status).json(payload);
}

module.exports = errorHandler;
