'use strict';

/**
 * Application error carrying an HTTP status and a stable machine code.
 * The error middleware renders these as { error: { message, code, details? } }.
 */
class ApiError extends Error {
  constructor(status, message, code = 'error', details = undefined) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  static badRequest(message = 'Bad request', code = 'bad_request', details) {
    return new ApiError(400, message, code, details);
  }
  static unauthorized(message = 'Unauthorized', code = 'unauthorized') {
    return new ApiError(401, message, code);
  }
  static forbidden(message = 'Forbidden', code = 'forbidden') {
    return new ApiError(403, message, code);
  }
  static notFound(message = 'Not found', code = 'not_found') {
    return new ApiError(404, message, code);
  }
  static conflict(message = 'Conflict', code = 'conflict') {
    return new ApiError(409, message, code);
  }
  static unprocessable(message = 'Unprocessable entity', code = 'unprocessable', details) {
    return new ApiError(422, message, code, details);
  }
}

module.exports = ApiError;
