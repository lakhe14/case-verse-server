'use strict';

const crypto = require('crypto');

module.exports = function requestId(req, res, next) {
  req.requestId = crypto.randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  next();
};
