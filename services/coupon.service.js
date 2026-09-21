'use strict';

const { Op } = require('sequelize');
const db = require('../models');
const ApiError = require('../utils/ApiError');

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

  if (coupon.usage_limit_total != null) {
    const totalUsed = await db.CouponUsage.count({ where: { coupon_id: coupon.id }, transaction });
    if (totalUsed >= coupon.usage_limit_total) {
      throw ApiError.badRequest('Coupon usage limit reached', 'coupon_exhausted');
    }
  }
  if (coupon.usage_limit_per_user != null && userId) {
    const userUsed = await db.CouponUsage.count({
      where: { coupon_id: coupon.id, user_id: userId },
      transaction,
    });
    if (userUsed >= coupon.usage_limit_per_user) {
      throw ApiError.badRequest('You have already used this coupon', 'coupon_used_by_user');
    }
  }

  let discount =
    coupon.discount_type === 'percentage'
      ? (subtotal * Number(coupon.discount_value)) / 100
      : Number(coupon.discount_value);
  discount = Math.min(discount, subtotal);
  discount = Number(discount.toFixed(2));

  return { coupon, discount_amount: discount };
}

module.exports = { validateCoupon };
