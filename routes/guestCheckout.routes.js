'use strict';

const express = require('express');
const validate = require('../middleware/validate');
const upload = require('../middleware/paymentProofUpload');
const ctrl = require('../controllers/guestCheckout.controller');
const v = require('../validators/order.validators');

// Fully public — no requireAuth. Ownership after order creation is enforced
// by the guest access token alone (see order.service.js resolveGuestToken).
const router = express.Router();

router.post('/preview', validate({ body: v.guestPreviewSchema }), ctrl.preview);
router.post('/orders', validate({ body: v.guestPlaceOrderSchema }), ctrl.place);
router.get('/orders/:token', validate({ params: v.guestTokenParam }), ctrl.get);
router.post('/orders/:token/cancel', validate({ params: v.guestTokenParam }), ctrl.cancel);
router.post('/orders/:token/payment-proof', validate({ params: v.guestTokenParam }), upload.single, ctrl.uploadProof);
router.post('/orders/:token/payment-method/cod', validate({ params: v.guestTokenParam }), ctrl.requestCod);

module.exports = router;
