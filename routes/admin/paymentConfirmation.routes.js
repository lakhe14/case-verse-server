'use strict';

const express = require('express');
const validate = require('../../middleware/validate');
const { requirePermission } = require('../../middleware/auth');
const { idParam } = require('../../validators/common');
const ctrl = require('../../controllers/paymentConfirmation.controller');
const v = require('../../validators/admin.validators');
const { staffPaymentActions } = require('../../middleware/rateLimiters');

const router = express.Router();
const canManage = requirePermission('manage_order_payments');
router.get('/payment-confirmations', canManage, validate({ query: v.paymentQueueQuery }), ctrl.listQueue);
router.post('/payment-confirmations/:id/approve', staffPaymentActions, canManage, validate({ params: idParam, body: v.paymentReviewSchema }), ctrl.approve);
router.post('/payment-confirmations/:id/reject', staffPaymentActions, canManage, validate({ params: idParam, body: v.paymentReviewSchema }), ctrl.reject);
router.get('/payment-confirmations/:id/proof', canManage, validate({ params: idParam }), ctrl.proof);
module.exports = router;
