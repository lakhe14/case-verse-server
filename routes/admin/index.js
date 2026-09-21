'use strict';

const express = require('express');
const { requireAuth, requireType } = require('../../middleware/auth');

const router = express.Router();

// Every admin route requires a valid staff token; individual routes add
// requirePermission(...) for the specific capability.
router.use(requireAuth, requireType('staff'));

router.use(require('./catalog.routes'));
router.use(require('./order.routes'));
router.use(require('./paymentConfirmation.routes'));
router.use(require('./review.routes'));
router.use(require('./coupon.routes'));
router.use(require('./analytics.routes'));
router.use(require('./staff.routes'));
router.use(require('./settings.routes'));

module.exports = router;
