'use strict';

const express = require('express');

const router = express.Router();

router.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

router.use('/auth', require('./auth.routes'));
router.use('/staff', require('./staff.routes'));
router.use('/addresses', require('./address.routes'));
router.use('/categories', require('./category.routes'));
router.use('/attributes', require('./attribute.routes'));
router.use('/products', require('./product.routes'));
router.use('/cart', require('./cart.routes'));
router.use('/campaign', require('./campaign.routes'));
router.use('/wishlist', require('./wishlist.routes'));
router.use('/coupons', require('./coupon.routes'));
router.use('/orders', require('./order.routes'));
router.use('/orders', require('./paymentConfirmation.routes'));
router.use('/guest-checkout', require('./guestCheckout.routes'));
router.use('/reviews', require('./review.routes'));
router.use('/loyalty', require('./loyalty.routes'));
router.use('/admin', require('./admin/index'));

module.exports = router;
