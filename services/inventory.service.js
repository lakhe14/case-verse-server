'use strict';

/**
 * Inventory reservations.
 *
 *   physical  = product_variants.stock_quantity (changes only on payment
 *               confirmation, committed-order cancellation, or admin edits
 *               through setPhysicalStock, which never goes below reserved)
 *   reserved  = SUM(inventory_reservations.quantity) WHERE status = 'active'
 *               AND (expires_at IS NULL OR expires_at > now)
 *   available = max(physical - reserved, 0)  -> what customers can buy
 *
 * Reservation lifecycle (one row per order line):
 *   active -> committed  payment approved / COD confirmed: physical -= qty (once)
 *   active -> released   order cancelled before confirmation: physical unchanged
 *   active -> expired    TTL passed without payment action: physical unchanged
 *   committed -> restocked  confirmed order later cancelled: physical += qty (once)
 *
 * expires_at is the hold's deadline while the order waits on the CUSTOMER:
 *   placed / proof rejected  now + RESERVATION_TTL_MINUTES (60): pay or retry
 *   COD requested            now + RESERVATION_REVIEW_TTL_HOURS (72): no advance paid
 * expires_at is NULL while the order waits on STAFF: after a payment proof is
 * uploaded the customer may already have paid, so the hold never lapses on
 * its own; it ends only when staff approve (committed) or reject (back to a
 * 60 min retry deadline) or the order is cancelled (released).
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

const activeWhere = (now = new Date()) => ({ status: 'active', [Op.or]: [{ expires_at: null }, { expires_at: { [Op.gt]: now } }] });

/** True while a row still holds stock (see activeWhere). */
const isLive = (row, now = new Date()) => row.status === 'active' && (row.expires_at === null || row.expires_at > now);

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
 * Customer-side deadline for still-live holds (review holds included):
 * 'cod' = COD requested (review TTL, 72 h), 'retry' = proof rejected (60 min
 * to upload a new one). A hold that already lapsed is NOT revived here: its
 * stock may have been sold since, so approval re-validates it (commitForOrder).
 */
async function setHoldDeadline(orderId, window, transaction) {
  const expiresAt = new Date(Date.now() + (window === 'cod' ? reviewTtlMs() : pendingTtlMs()));
  await db.InventoryReservation.update({ expires_at: expiresAt }, { where: { order_id: orderId, ...activeWhere() }, transaction });
}

/**
 * Payment proof uploaded: the order now waits on staff, so its hold loses its
 * deadline (expires_at NULL) until staff approve or reject. A line whose hold
 * lapsed before the upload is revived only if its stock is still unsold
 * (variant locked, other live holds counted); otherwise it stays lapsed and
 * approval re-validates it. Returns the number of lines left unprotected.
 */
async function holdUntilReviewed(orderId, transaction) {
  const rows = (await lockOrderReservations(orderId, transaction)).filter((r) => r.status === 'active' || r.status === 'expired');
  if (!rows.length) return 0;
  const now = new Date();
  const lapsed = rows.filter((r) => !isLive(r, now));
  const unavailable = new Set();
  if (lapsed.length) {
    const ids = lapsed.map((r) => r.variant_id);
    const variants = await db.ProductVariant.findAll({ where: { id: { [Op.in]: ids } }, lock: transaction.LOCK.UPDATE, transaction });
    const byId = new Map(variants.map((v) => [v.id, v]));
    const others = await reservedByVariant(ids, { transaction, excludeOrderId: orderId });
    for (const row of lapsed) {
      const variant = byId.get(row.variant_id);
      if (!variant || variant.stock_quantity - (others.get(row.variant_id) || 0) < row.quantity) unavailable.add(row.id);
    }
  }
  const protectedIds = rows.filter((r) => !unavailable.has(r.id)).map((r) => r.id);
  if (protectedIds.length) {
    await db.InventoryReservation.update({ status: 'active', expires_at: null }, { where: { id: { [Op.in]: protectedIds } }, transaction });
  }
  return unavailable.size;
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
  const lapsed = pending.filter((row) => !isLive(row, now));
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

/**
 * Orders placed before reservations existed were deducted at placement; on
 * cancellation they are restocked from their items.
 */
async function restockLegacyItems(items, transaction) {
  for (const item of items) {
    await db.ProductVariant.increment({ stock_quantity: item.quantity }, { where: { id: item.variant_id }, transaction });
  }
}

/**
 * Admin edit of physical stock, the only non-order path that changes it.
 * Must run inside a STOCK_TX transaction: the variant row is locked first, so
 * placement (which locks the same row before reserving) and payment
 * confirmation are serialized with this check-and-write. Physical stock may
 * never be set below the quantity held by active, unexpired reservations.
 * Returns { physical, reserved, available } after the write.
 */
async function setPhysicalStock(variantId, quantity, transaction) {
  const variant = await db.ProductVariant.findByPk(variantId, { lock: transaction.LOCK.UPDATE, transaction });
  if (!variant) throw ApiError.notFound('Variant not found', 'variant_not_found');
  const reserved = (await reservedByVariant([variant.id], { transaction })).get(variant.id);
  if (quantity !== variant.stock_quantity) {
    if (quantity < reserved) {
      throw new ApiError(
        409,
        'Stock cannot be set below the quantity currently reserved for active orders.',
        'stock_below_reserved',
        { physical_stock: variant.stock_quantity, reserved_quantity: reserved, minimum_allowed_stock: reserved }
      );
    }
    variant.stock_quantity = quantity;
    await variant.save({ transaction });
  }
  return { physical: variant.stock_quantity, reserved, available: Math.max(variant.stock_quantity - reserved, 0) };
}

/**
 * Catalog imports set physical stock from an external source of truth. They
 * must not undercut active holds either: this lists every requested change
 * that would go below its variant's active reserved quantity, so the importer
 * can refuse the whole import and report the SKUs. Unchanged values never
 * conflict. requests: [{ variant, quantity }] with loaded variant instances.
 */
async function findStockFloorConflicts(requests, { transaction } = {}) {
  const reserved = await reservedByVariant(requests.map((r) => r.variant.id), { transaction });
  return requests
    .filter(({ variant, quantity }) => quantity !== variant.stock_quantity && quantity < reserved.get(variant.id))
    .map(({ variant, quantity }) => ({
      sku: variant.sku,
      requested_physical_stock: quantity,
      reserved_quantity: reserved.get(variant.id),
      minimum_allowed_stock: reserved.get(variant.id),
    }));
}

/* ------------------------------- Retention ------------------------------- */

const days = (value, fallback) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

/**
 * How long terminal rows are kept after their last status change (updated_at).
 * released/expired never moved physical stock; restocked rows describe a
 * deduction and its reversal, so they are kept longer. committed rows are the
 * record of a real deduction and are never pruned automatically.
 */
function retentionDays() {
  const base = days(process.env.INVENTORY_RESERVATION_RETENTION_DAYS, 90);
  return {
    released: base,
    expired: base,
    restocked: days(process.env.INVENTORY_RESTOCKED_RETENTION_DAYS, 180),
  };
}

const PRUNE_BATCH_SIZE = 500;

/**
 * Only rows of CANCELLED orders are eligible. Order lifecycle code treats an
 * order with no reservation rows as a legacy order (deducted at placement),
 * so removing the rows of an order that can still be confirmed or cancelled
 * would make confirmation skip the deduction and cancellation restock stock
 * that was never taken. Cancelled is final (no transitions out of it), so its
 * rows are never read again. An expired hold on a still-pending order is
 * therefore kept until that order is cancelled.
 */
function pruneWhere(now) {
  const policy = retentionDays();
  const cutoff = (n) => new Date(now.getTime() - n * 24 * 60 * 60 * 1000);
  return {
    [Op.or]: Object.entries(policy).map(([status, n]) => ({ status, updated_at: { [Op.lt]: cutoff(n) } })),
  };
}

const cancelledOrder = { model: db.Order, as: 'order', attributes: [], where: { status: 'cancelled' }, required: true };

/**
 * Deletes old terminal reservation rows in bounded batches (never a
 * full-table delete). Dry run by default: counts only.
 * Returns { dry_run, eligible, deleted, batches, retention_days }.
 */
async function pruneTerminalReservations({ execute = false, batchSize = PRUNE_BATCH_SIZE, maxBatches = 1000, now = new Date() } = {}) {
  const size = Math.max(1, Math.min(Number(batchSize) || PRUNE_BATCH_SIZE, 5000));
  const where = pruneWhere(now);
  const eligible = await db.InventoryReservation.count({ where, include: [cancelledOrder] });
  const result = { dry_run: !execute, eligible, deleted: 0, batches: 0, retention_days: retentionDays() };
  if (!execute) return result;
  while (result.batches < maxBatches) {
    const rows = await db.InventoryReservation.findAll({ where, include: [cancelledOrder], attributes: ['id'], order: [['id', 'ASC']], limit: size });
    if (!rows.length) break;
    // Re-check status and age at delete time so a row changed since the select is kept.
    result.deleted += await db.InventoryReservation.destroy({ where: { id: { [Op.in]: rows.map((r) => r.id) }, ...where } });
    result.batches += 1;
    if (rows.length < size) break;
  }
  return result;
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
  isLive,
  setHoldDeadline,
  holdUntilReviewed,
  commitForOrder,
  releaseForOrder,
  restockLegacyItems,
  setPhysicalStock,
  findStockFloorConflicts,
  retentionDays,
  pruneTerminalReservations,
  expireStale,
  assertCommitted,
};
