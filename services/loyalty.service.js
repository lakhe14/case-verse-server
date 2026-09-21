'use strict';

const db = require('../models');
const env = require('../config/env');
const ApiError = require('../utils/ApiError');

/** Recompute the cached users.loyalty_points from the ledger (source of truth). */
async function recalcBalance(userId, transaction) {
  const total = (await db.LoyaltyTransaction.sum('points', {
    where: { user_id: userId },
    transaction,
  })) || 0;
  await db.User.update({ loyalty_points: total }, { where: { id: userId }, transaction });
  return total;
}

async function getBalance(userId) {
  const user = await db.User.findByPk(userId);
  return user ? user.loyalty_points : 0;
}

async function listTransactions(userId, { page = 1, limit = 20 } = {}) {
  const { rows, count } = await db.LoyaltyTransaction.findAndCountAll({
    where: { user_id: userId },
    order: [['id', 'DESC']],
    limit,
    offset: (page - 1) * limit,
  });
  return {
    data: rows,
    pagination: { page, limit, total: count, pages: Math.ceil(count / limit) },
  };
}

/** Award points for a delivered order. Idempotent per order. */
async function awardForDeliveredOrder(order, transaction) {
  const already = await db.LoyaltyTransaction.findOne({
    where: { order_id: order.id, type: 'earn' },
    transaction,
  });
  if (already) return already;

  const points = Math.floor(Number(order.total_amount) * env.loyalty.earnRate);
  if (points <= 0) return null;

  const txn = await db.LoyaltyTransaction.create(
    {
      user_id: order.user_id,
      order_id: order.id,
      points,
      type: 'earn',
      note: `Earned on delivery of order ${order.order_number}`,
    },
    { transaction }
  );
  await recalcBalance(order.user_id, transaction);
  return txn;
}

/**
 * Reserve points for redemption at checkout. Writes a negative ledger row and
 * returns the currency value applied as discount.
 */
async function redeemPoints({ userId, points, orderId, note }, transaction) {
  const balance =
    (await db.LoyaltyTransaction.sum('points', { where: { user_id: userId }, transaction })) || 0;
  if (points > balance) {
    throw ApiError.badRequest('Not enough loyalty points', 'insufficient_points');
  }
  await db.LoyaltyTransaction.create(
    {
      user_id: userId,
      order_id: orderId || null,
      points: -Math.abs(points),
      type: 'redeem',
      note: note || 'Redeemed at checkout',
    },
    { transaction }
  );
  await recalcBalance(userId, transaction);
  return Number((points * env.loyalty.pointValue).toFixed(2));
}

function pointsToCurrency(points) {
  return Number((points * env.loyalty.pointValue).toFixed(2));
}

module.exports = {
  recalcBalance,
  getBalance,
  listTransactions,
  awardForDeliveredOrder,
  redeemPoints,
  pointsToCurrency,
};
