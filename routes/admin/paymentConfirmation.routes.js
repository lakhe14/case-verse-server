'use strict';

const express = require('express');
const validate = require('../../middleware/validate');
const { requirePermission } = require('../../middleware/auth');
const { idParam } = require('../../validators/common');
const ctrl = require('../../controllers/paymentConfirmation.controller');

const router = express.Router();
const canManage = requirePermission('manage_order_payments');
router.get('/payment-confirmations', canManage, ctrl.listQueue);
router.post('/payment-confirmations/:id/approve', canManage, validate({ params: idParam }), ctrl.approve);
router.post('/payment-confirmations/:id/reject', canManage, validate({ params: idParam }), ctrl.reject);
router.get('/payment-confirmations/:id/proof', canManage, validate({ params: idParam }), ctrl.proof);
module.exports = router;
