'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const validate = require('../middleware/validate');
const upload = require('../middleware/paymentProofUpload');
const ctrl = require('../controllers/guestCheckout.controller');
const v = require('../validators/order.validators');
const limits = require('../middleware/rateLimiters');
const { parseIdempotencyKey } = require('../services/guestIdempotency');

// Fully public — no requireAuth. Ownership after order creation is enforced
// by the guest access token alone (see order.service.js resolveGuestToken).
const router = express.Router();
const guestOrderLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false, message: { error: { message: 'Too many guest checkout attempts. Please try again later.', code: 'rate_limited' } } });
const guestProofLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 8, standardHeaders: true, legacyHeaders: false, message: { error: { message: 'Too many payment-proof uploads. Please try again later.', code: 'rate_limited' } } });

router.post('/preview', validate({ body: v.guestPreviewSchema }), ctrl.preview);
// Idempotency-Key is validated before the body so a malformed key costs nothing.
const requireIdempotencyKey = (req, _res, next) => {
  try {
    parseIdempotencyKey(req.get('Idempotency-Key'));
    next();
  } catch (error) {
    next(error);
  }
};

router.post('/orders', guestOrderLimiter, requireIdempotencyKey, validate({ body: v.guestPlaceOrderSchema }), ctrl.place);
router.get('/orders/:token', limits.guestLookup, validate({ params: v.guestTokenParam }), ctrl.get);
router.post('/orders/:token/cancel', validate({ params: v.guestTokenParam }), ctrl.cancel);
router.post('/orders/:token/payment-proof', guestProofLimiter, validate({ params: v.guestTokenParam }), upload.single, ctrl.uploadProof);
router.post('/orders/:token/payment-method/cod', limits.guestCod, validate({ params: v.guestTokenParam }), ctrl.requestCod);

module.exports = router;
