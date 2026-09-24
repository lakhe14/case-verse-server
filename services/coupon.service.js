'use strict';

const { Op } = require('sequelize');
const db = require('../models');
const ApiError = require('../utils/ApiError');

/**
 * Active uses (released_at IS NULL) against the total and per-customer
 * limits. Only authoritative while the caller holds the coupon row lock
 * (lockForRedemption / redeemForOrder); for checkout preview it is advisory.
 */
async function assertWithinUsageLimits(coupon, userId, transaction) {
  if (coupon.usage_limit_total != null) {
    const totalUsed = await db.CouponUsage.count({ where: { coupon_id: coupon.id, released_at: null }, transaction });
    if (totalUsed >= coupon.usage_limit_total) {
      throw ApiError.badRequest('Sorry, this coupon has reached its usage limit.', 'coupon_exhausted');
    }
  }
  if (coupon.usage_limit_per_user != null && userId) {
    const userUsed = await db.CouponUsage.count({ where: { coupon_id: coupon.id, user_id: userId, released_at: null }, transaction });
    if (userUsed >= coupon.usage_limit_per_user) {
      throw ApiError.badRequest('You have already used this coupon the maximum number of times.', 'coupon_used_by_user');
    }
  }
}

/**
 * Order placement, before any variant is locked: takes the coupon row lock
 * for the rest of the transaction. Every placement redeeming this coupon then
 * waits here, so its usage count sees every earlier redemption as committed.
 */
async function lockForRedemption(code, transaction) {
  return db.Coupon.findOne({ where: { code: code.trim().toUpperCase() }, lock: transaction.LOCK.UPDATE, transaction });
}

/**
 * The authoritative check-and-record, inside the order transaction and under
 * the coupon row lock: re-checks the limits against active uses, then records
 * the use. If the transaction later fails, the use rolls back with the order.
 */
async function redeemForOrder({ couponId, userId, orderId }, transaction) {
  const coupon = await db.Coupon.findByPk(couponId, { lock: transaction.LOCK.UPDATE, transaction });
  if (!coupon || !coupon.is_active) throw ApiError.badRequest('Invalid coupon code', 'coupon_invalid');
  await assertWithinUsageLimits(coupon, userId, transaction);
  return db.CouponUsage.create({ coupon_id: coupon.id, user_id: userId, order_id: orderId }, { transaction });
}

/**
 * Validate a coupon code for a given user and order subtotal.
 * Returns { coupon, discount_amount } or throws an ApiError describing why not.
 */
async function validateCoupon({ code, userId, subtotal }, transaction) {
  const coupon = await db.Coupon.findOne({
    where: { code: code.trim().toUpperCase() },
    transaction,
  });
  if (!coupon || !coupon.is_active) {
    throw ApiError.badRequest('Invalid coupon code', 'coupon_invalid');
  }

  const now = new Date();
  if (coupon.starts_at && now < coupon.starts_at) {
    throw ApiError.badRequest('Coupon is not active yet', 'coupon_not_started');
  }
  if (coupon.ends_at && now > coupon.ends_at) {
    throw ApiError.badRequest('Coupon has expired', 'coupon_expired');
  }
  if (subtotal < Number(coupon.min_order_amount || 0)) {
    throw ApiError.badRequest(
      `Requires a minimum order of ${coupon.min_order_amount}`,
      'coupon_min_order'
    );
  }

  await assertWithinUsageLimits(coupon, userId, transaction);

  let discount =
    coupon.discount_type === 'percentage'
      ? (subtotal * Number(coupon.discount_value)) / 100
      : Number(coupon.discount_value);
  discount = Math.min(discount, subtotal);
  discount = Number(discount.toFixed(2));

  return { coupon, discount_amount: discount };
}

module.exports = { validateCoupon, lockForRedemption, redeemForOrder };
