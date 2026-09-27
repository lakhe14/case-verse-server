'use strict';

const express = require('express');
const validate = require('../middleware/validate');
const limits = require('../middleware/rateLimiters');
const ctrl = require('../controllers/tracking.controller');
const v = require('../validators/tracking.validators');

// Public: order number + delivery phone. POST keeps the phone out of URLs and access logs.
const router = express.Router();

router.post(
  '/',
  limits.trackingLookup,
  limits.trackingFailuresPerIp,
  validate({ body: v.trackOrderSchema }),
  limits.trackingFailuresPerOrder,
  ctrl.track
);

module.exports = router;
