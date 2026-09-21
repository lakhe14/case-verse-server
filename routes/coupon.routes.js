'use strict';

const express = require('express');
const validate = require('../middleware/validate');
const { requireAuth, requireType } = require('../middleware/auth');
const ctrl = require('../controllers/coupon.controller');
const v = require('../validators/order.validators');

const router = express.Router();

router.post(
  '/validate',
  requireAuth,
  requireType('customer'),
  validate({ body: v.validateCouponSchema }),
  ctrl.validate
);

module.exports = router;
