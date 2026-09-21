'use strict';

const env = require('../config/env');
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
    console.error(err);
  }

  const payload = { error: { message, code } };
  if (details) payload.error.details = details;
  if (!env.isProd && status >= 500) payload.error.stack = err.stack;

  res.status(status).json(payload);
}

module.exports = errorHandler;
