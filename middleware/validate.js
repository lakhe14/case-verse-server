'use strict';

const { ZodError } = require('zod');
const ApiError = require('../utils/ApiError');

/**
 * Build a middleware that validates and coerces req.body / req.query / req.params
 * against the given zod schemas. Parsed values replace the originals.
 *
 *   validate({ body: createAddressSchema })
 */
function validate(schemas) {
  return (req, res, next) => {
    try {
      for (const key of ['body', 'query', 'params']) {
        if (schemas[key]) {
          req[key] = schemas[key].parse(req[key]);
        }
      }
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        const details = err.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        }));
        return next(ApiError.unprocessable('Validation failed', 'validation_failed', details));
      }
      next(err);
    }
  };
}

module.exports = validate;
