'use strict';

/**
 * Inventory reservations.
 *
 *   physical  = product_variants.stock_quantity (changes only on payment
 *               confirmation, committed-order cancellation, or admin edits)
 *   reserved  = SUM(inventory_reservations.quantity) WHERE status = 'active'
 *               AND expires_at > now
 *   available = max(physical - reserved, 0)  -> what customers can buy
 *
 * Reservation lifecycle (one row per order line):
 *   active -> committed  payment approved / COD confirmed: physical -= qty (once)
 *   active -> released   order cancelled before confirmation: physical unchanged
 *   active -> expired    TTL passed without payment action: physical unchanged
 *   committed -> restocked  confirmed order later cancelled: physical += qty (once)
 *
 * Orders placed before reservations existed have no rows: their stock was
 * already deducted at placement, so confirmation deducts nothing and
 * cancellation restocks from order_items as before (see order.service).
 *
 * Correctness never depends on a sweeper: every availability read filters by
 * expires_at; expireStale() only tidies statuses.
 */

const { Op, Transaction } = require('sequelize');
const db = require('../models');
const ApiError = require('../utils/ApiError');

const minutes = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

// Unpaid order hold: long enough to scan the QR, pay and upload proof.
const pendingTtlMs = () => minutes(process.env.RESERVATION_TTL_MINUTES, 60) * 60 * 1000;
// After proof upload / COD request the customer has acted; hold through staff review.
const reviewTtlMs = () => minutes(process.env.RESERVATION_REVIEW_TTL_HOURS, 72) * 60 * 60 * 1000;

const activeWhere = (now = new Date()) => ({ status: 'active', expires_at: { [Op.gt]: now } });

/**
 * Active reserved quantity per variant. Transactions that decide on stock
 * (placement, payment review) run at READ COMMITTED and lock the variant rows
 * first: every concurrent writer for that variant is serialized on the variant
 * lock, and this plain read then sees the latest committed reservations.
 */
async function reservedByVariant(variantIds, { transaction, excludeOrderId } = {}) {
  const ids = [...new Set(variantIds.filter(Boolean))];
  const reserved = new Map(ids.map((id) => [id, 0]));
  if (!ids.length) return reserved;
  const where = { variant_id: { [Op.in]: ids }, ...activeWhere() };
  if (excludeOrderId) where.order_id = { [Op.ne]: excludeOrderId };
  const rows = await db.InventoryReservation.findAll({
    where,
    attributes: ['variant_id', 'quantity'],
    transaction,
  });
  for (const row of rows) reserved.set(row.variant_id, reserved.get(row.variant_id) + row.quantity);
  return reserved;
}

/** Map variantId -> { physical, reserved, available } for loaded variant instances. */
async function availabilityFor(variants, options = {}) {
  const list = variants.filter(Boolean);
  const reserved = await reservedByVariant(list.map((v) => v.id), options);
  return new Map(list.map((v) => {
    const r = reserved.get(v.id) || 0;
    return [v.id, { physical: v.stock_quantity, reserved: r, available: Math.max(v.stock_quantity - r, 0) }];
  }));
}

async function reserveForOrder(orderId, lines, transaction) {
  const expiresAt = new Date(Date.now() + pendingTtlMs());
  await db.InventoryReservation.bulkCreate(
    lines.map((line) => ({ order_id: orderId, variant_id: line.variant_id, quantity: line.quantity, status: 'active', expires_at: expiresAt })),
    { transaction }
  );
}

async function lockOrderReservations(orderId, transaction) {
  return db.InventoryReservation.findAll({ where: { order_id: orderId }, lock: transaction.LOCK.UPDATE, transaction, order: [['id', 'ASC']] });
}

/**
 * Moves still-live holds to a new expiry (proof uploaded, COD requested,
 * proof rejected). A hold that already lapsed is NOT revived: its stock may
 * have been sold since, so approval re-validates it instead (commitForOrder).
 */
async function extendHold(orderId, { review }, transaction) {
  const expiresAt = new Date(Date.now() + (review ? reviewTtlMs() : pendingTtlMs()));
  await db.InventoryReservation.update({ expires_at: expiresAt }, { where: { order_id: orderId, ...activeWhere() }, transaction });
}

/**
 * Payment confirmed: deduct physical stock exactly once. Re-running is a no-op
 * because only non-committed rows are processed, under a row lock. A hold
 * that lapsed (expired, or active past its expiry) is re-validated against
 * current availability before committing; if the stock is gone the
 * confirmation is refused rather than overselling.
 * Returns the number of reservation rows committed by this call.
 */
async function commitForOrder(orderId, transaction) {
  const rows = await lockOrderReservations(orderId, transaction);
  const pending = rows.filter((row) => row.status !== 'committed' && row.status !== 'restocked');
  if (!pending.length) return 0;
  if (pending.some((row) => row.status === 'released')) {
    throw ApiError.conflict('This order has released its reserved stock and cannot be confirmed.', 'reservation_released');
  }
  const variants = await db.ProductVariant.findAll({
    where: { id: { [Op.in]: pending.map((row) => row.variant_id) } },
    lock: transaction.LOCK.UPDATE,
    transaction,
  });
  const byId = new Map(variants.map((v) => [v.id, v]));
  const now = new Date();
  const lapsed = pending.filter((row) => row.status === 'expired' || row.expires_at <= now);
  if (lapsed.length) {
    const others = await reservedByVariant(lapsed.map((row) => row.variant_id), { transaction, excludeOrderId: orderId });
    for (const row of lapsed) {
      const variant = byId.get(row.variant_id);
      if (!variant || variant.stock_quantity - (others.get(row.variant_id) || 0) < row.quantity) {
        throw ApiError.conflict('The reserved stock for this order has lapsed and is no longer available.', 'reservation_lapsed_insufficient_stock');
      }
    }
  }
  for (const row of pending) {
    const variant = byId.get(row.variant_id);
    if (!variant || variant.stock_quantity < row.quantity) {
      throw ApiError.conflict('Physical stock is lower than this order needs.', 'insufficient_physical_stock');
    }
    variant.stock_quantity -= row.quantity;
    await variant.save({ transaction });
    await row.update({ status: 'committed' }, { transaction });
  }
  return pending.length;
}

/**
 * Order cancelled. Returns { hadReservations } so legacy orders (no rows,
 * deducted at placement) can fall back to the historical restock.
 */
async function releaseForOrder(orderId, transaction) {
  const rows = await lockOrderReservations(orderId, transaction);
  for (const row of rows) {
    if (row.status === 'active' || row.status === 'expired') {
      await row.update({ status: 'released' }, { transaction });
    } else if (row.status === 'committed') {
      await db.ProductVariant.increment({ stock_quantity: row.quantity }, { where: { id: row.variant_id }, transaction });
      await row.update({ status: 'restocked' }, { transaction });
    }
  }
  return { hadReservations: rows.length > 0 };
}

/** Bookkeeping only: marks lapsed holds as expired. Availability already ignores them. */
async function expireStale({ transaction } = {}) {
  const [count] = await db.InventoryReservation.update(
    { status: 'expired' },
    { where: { status: 'active', expires_at: { [Op.lte]: new Date() } }, transaction }
  );
  return count;
}

async function assertCommitted(orderId, transaction) {
  const open = await db.InventoryReservation.count({ where: { order_id: orderId, status: { [Op.ne]: 'committed' } }, transaction });
  if (open) throw ApiError.conflict('Inventory for this order has not been committed.', 'inventory_not_committed');
}

// Isolation for transactions that read reservations to decide on stock.
const STOCK_TX = { isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED };

module.exports = {
  STOCK_TX,
  pendingTtlMs,
  reviewTtlMs,
  reservedByVariant,
  availabilityFor,
  reserveForOrder,
  extendHold,
  commitForOrder,
  releaseForOrder,
  expireStale,
  assertCommitted,
};
