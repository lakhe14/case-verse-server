'use strict';

const express = require('express');
const db = require('../models');
const cache = require('../services/cache.service');

const router = express.Router();

/*
 * MySQL is required: if it does not answer within 2 s the API is unhealthy
 * (503). Redis is optional: a missing cache is "disabled", an unreachable one
 * "degraded" (still 200: every read falls back to MySQL). No URLs or
 * credentials are reported.
 */
router.get('/health', async (req, res) => {
  let database = 'ok';
  let timer;
  try {
    await Promise.race([
      db.sequelize.query('SELECT 1'),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 2000); }),
    ]);
  } catch {
    database = 'down';
  } finally {
    clearTimeout(timer);
  }
  const cacheStatus = await cache.status();
  const status = database !== 'ok' ? 'unhealthy' : cacheStatus === 'degraded' ? 'degraded' : 'ok';
  res.status(database === 'ok' ? 200 : 503).json({ status, time: new Date().toISOString(), database, cache: cacheStatus });
});

router.use('/auth', require('./auth.routes'));
router.use('/staff', require('./staff.routes'));
router.use('/addresses', require('./address.routes'));
router.use('/categories', require('./category.routes'));
router.use('/attributes', require('./attribute.routes'));
router.use('/products', require('./product.routes'));
router.use('/cart', require('./cart.routes'));
router.use('/campaign', require('./campaign.routes'));
router.use('/shipping', require('./shipping.routes'));
router.use('/wishlist', require('./wishlist.routes'));
router.use('/coupons', require('./coupon.routes'));
router.use('/orders', require('./order.routes'));
router.use('/orders', require('./paymentConfirmation.routes'));
router.use('/guest-checkout', require('./guestCheckout.routes'));
router.use('/reviews', require('./review.routes'));
router.use('/loyalty', require('./loyalty.routes'));
router.use('/admin', require('./admin/index'));

module.exports = router;
