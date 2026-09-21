'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const validate = require('../middleware/validate');
const ctrl = require('../controllers/auth.controller');
const v = require('../validators/auth.validators');

const router = express.Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: 'Too many attempts, try again later', code: 'rate_limited' } },
});

router.post('/login', authLimiter, validate({ body: v.loginSchema }), ctrl.staffLogin);

module.exports = router;
