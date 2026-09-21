'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const validate = require('../middleware/validate');
const { requireAuth } = require('../middleware/auth');
const ctrl = require('../controllers/auth.controller');
const v = require('../validators/auth.validators');

const router = express.Router();

// Tighter limits on credential endpoints to slow brute force.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: 'Too many attempts, try again later', code: 'rate_limited' } },
});

router.post('/register', authLimiter, validate({ body: v.registerSchema }), ctrl.register);
router.post('/login', authLimiter, validate({ body: v.loginSchema }), ctrl.login);
router.post('/refresh', validate({ body: v.refreshSchema }), ctrl.refresh);
router.post('/logout', ctrl.logout);
router.post(
  '/forgot-password',
  authLimiter,
  validate({ body: v.forgotPasswordSchema }),
  ctrl.forgotPassword
);
router.post(
  '/reset-password',
  authLimiter,
  validate({ body: v.resetPasswordSchema }),
  ctrl.resetPassword
);

router.get('/me', requireAuth, ctrl.me);

module.exports = router;
