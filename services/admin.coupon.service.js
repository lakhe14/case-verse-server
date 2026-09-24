'use strict';

const db = require('../models');
const ApiError = require('../utils/ApiError');

async function list({ page = 1, limit = 20 } = {}) {
  const { rows, count } = await db.Coupon.findAndCountAll({
    order: [['created_at', 'DESC']],
    limit,
    offset: (page - 1) * limit,
  });
  const withUsage = await Promise.all(
    rows.map(async (c) => ({
      ...c.get({ plain: true }),
      // Active uses count toward limits; released ones (unpaid order cancelled) do not.
      times_used: await db.CouponUsage.count({ where: { coupon_id: c.id, released_at: null } }),
      times_released: await db.CouponUsage.count({ where: { coupon_id: c.id, released_at: { [db.Sequelize.Op.ne]: null } } }),
    }))
  );
  return { data: withUsage, pagination: { page, limit, total: count, pages: Math.ceil(count / limit) } };
}

async function create(payload) {
  const code = payload.code.trim().toUpperCase();
  const existing = await db.Coupon.findOne({ where: { code } });
  if (existing) throw ApiError.conflict('Coupon code already exists', 'code_taken');
  return db.Coupon.create({ ...payload, code });
}

async function update(couponId, payload) {
  const coupon = await db.Coupon.findByPk(couponId);
  if (!coupon) throw ApiError.notFound('Coupon not found', 'coupon_not_found');
  const patch = { ...payload };
  if (patch.code) patch.code = patch.code.trim().toUpperCase();
  await coupon.update(patch);
  return coupon;
}

async function remove(couponId) {
  const coupon = await db.Coupon.findByPk(couponId);
  if (!coupon) throw ApiError.notFound('Coupon not found', 'coupon_not_found');
  await coupon.destroy();
}

module.exports = { list, create, update, remove };
