'use strict';

const express = require('express');
const validate = require('../middleware/validate');
const { requireAuth, requireType } = require('../middleware/auth');
const { idParam } = require('../validators/common');
const upload = require('../middleware/paymentProofUpload');
const limits = require('../middleware/rateLimiters');
const ctrl = require('../controllers/paymentConfirmation.controller');

const router = express.Router();
router.use(requireAuth, requireType('customer'));
router.post('/:id/payment-proof', limits.customerProof, validate({ params: idParam }), upload.single, ctrl.uploadProof);
router.post('/:id/payment-method/cod', limits.customerCod, validate({ params: idParam }), ctrl.requestCod);
module.exports = router;
