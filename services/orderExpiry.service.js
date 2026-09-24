'use strict';

/**
 * Cancels unpaid orders whose inventory hold has lapsed, so they do not stay
 * "pending" forever. Run explicitly (npm run orders:cancel-expired); there is
 * no scheduler.
 *
 * The reservation's expires_at is the payment window. It already encodes every
 * payment state: 60 min after placement or after a rejected proof (retry
 * window), 72 h after a proof upload or COD request (review window).
 *
 * Cancellation goes through orderService.transitionOrderStatus, like any other
 * cancellation: the holds are released and physical stock is untouched, since
 * an unpaid order never deducted it.
 */

const { Op } = require('sequelize');
const db = require('../models');
const inventory = require('./inventory.service');
const orderService = require('./order.service');

const TIMEOUT_NOTE = 'Cancelled automatically: payment was not confirmed before the reserved stock expired.';
// Payment states in which nothing has been confirmed yet.
const UNPAID_PAYMENT_STATUSES = ['pending', 'proof_uploaded', 'rejected', 'cod_pending'];
// The customer has acted and staff review is pending.
const REVIEW_PAYMENT_STATUSES = ['proof_uploaded', 'cod_pending'];
const BATCH_SIZE = 100;

/**
 * Pure eligibility rule. Returns { eligible, reason }; reason names why an
 * order is kept when it is not eligible.
 */
function staleUnpaidDecision({ order, payment, reservations, now = new Date() }) {
  if (order.status !== 'pending') return { eligible: false, reason: 'order_not_pending' };
  // Orders from before payment confirmations or reservations keep their legacy workflow.
  if (!payment) return { eligible: false, reason: 'legacy_no_payment_record' };
  if (!reservations.length) return { eligible: false, reason: 'legacy_no_reservations' };
  if (!UNPAID_PAYMENT_STATUSES.includes(payment.status)) return { eligible: false, reason: 'payment_confirmed' };
  // Any committed/released/restocked row means stock already moved: not a plain unpaid hold.
  if (reservations.some((r) => r.status !== 'active' && r.status !== 'expired')) {
    return { eligible: false, reason: 'reservation_not_open' };
  }
  if (reservations.some((r) => r.status === 'active' && r.expires_at > now)) return { eligible: false, reason: 'hold_active' };
  // A proof or COD request made after the hold had already lapsed does not
  // revive the hold (inventory.extendHold), but it still gets its full review
  // window before the order is cancelled; a rejection gets its retry window.
  const window = REVIEW_PAYMENT_STATUSES.includes(payment.status) ? inventory.reviewTtlMs() : inventory.pendingTtlMs();
  if (payment.updated_at && payment.updated_at.getTime() + window > now.getTime()) {
    return { eligible: false, reason: 'recent_payment_activity' };
  }
  return { eligible: true, reason: 'eligible' };
}

/** Pending orders with at least one lapsed hold, ids after `afterId`, ascending. */
async function candidateIds({ afterId, limit, now }) {
  const rows = await db.Order.findAll({
    where: { status: 'pending', id: { [Op.gt]: afterId } },
    include: [{
      model: db.InventoryReservation,
      as: 'reservations',
      attributes: [],
      required: true,
      where: { status: { [Op.in]: ['active', 'expired'] }, expires_at: { [Op.lte]: now } },
    }],
    attributes: ['id'],
    group: ['Order.id'],
    order: [['id', 'ASC']],
    limit,
    subQuery: false,
  });
  return rows.map((row) => row.id);
}

async function loadState(orderId, transaction) {
  const lock = transaction ? transaction.LOCK.UPDATE : undefined;
  // Same lock order as payment review (confirmation row, then order), so a
  // staff approval racing this run waits instead of deadlocking.
  const payment = await db.OrderPaymentConfirmation.findOne({ where: { order_id: orderId }, lock, transaction });
  const order = await db.Order.findByPk(orderId, { lock, transaction });
  if (!order) return null;
  const reservations = await db.InventoryReservation.findAll({ where: { order_id: orderId }, lock, transaction });
  return { order, payment, reservations };
}

const isLockConflict = (error) => ['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'].includes(error?.parent?.code || error?.original?.code);

/**
 * Cancels one order if it is still eligible once its rows are locked.
 * Returns the decision reason ('cancelled' when this call cancelled it).
 */
async function cancelIfStale(orderId, now = new Date()) {
  return db.sequelize.transaction(inventory.STOCK_TX, async (t) => {
    const state = await loadState(orderId, t);
    if (!state) return 'order_missing';
    const decision = staleUnpaidDecision({ ...state, now });
    if (!decision.eligible) return decision.reason;
    await orderService.transitionOrderStatus(orderId, { status: 'cancelled', note: TIMEOUT_NOTE, cancellationReason: 'payment_timeout' }, null, t);
    return 'cancelled';
  });
}

/**
 * Finds stale unpaid orders in bounded batches. Dry run (default) only
 * evaluates; execute re-checks each order under row locks inside its own
 * transaction and cancels it exactly once, so concurrent runs cannot double
 * cancel. Returns aggregate counts only.
 */
async function cancelExpiredUnpaidOrders({ execute = false, batchSize = BATCH_SIZE, maxBatches = 100, now = new Date() } = {}) {
  const size = Math.max(1, Math.min(Number(batchSize) || BATCH_SIZE, 500));
  const result = { dry_run: !execute, candidates: 0, eligible: 0, cancelled: 0, kept: {}, batches: 0 };
  let afterId = 0;
  while (result.batches < maxBatches) {
    const ids = await candidateIds({ afterId, limit: size, now });
    if (!ids.length) break;
    result.batches += 1;
    for (const id of ids) {
      result.candidates += 1;
      let reason;
      if (!execute) {
        const state = await loadState(id);
        reason = state ? staleUnpaidDecision({ ...state, now }).reason : 'order_missing';
      } else {
        try {
          reason = await cancelIfStale(id, now);
        } catch (error) {
          // Another writer (payment review, customer cancel) holds the rows; the next run retries.
          if (!isLockConflict(error)) throw error;
          reason = 'lock_conflict';
        }
      }
      if (reason === 'eligible' || reason === 'cancelled') result.eligible += 1;
      if (reason === 'cancelled') result.cancelled += 1;
      if (reason !== 'eligible' && reason !== 'cancelled') result.kept[reason] = (result.kept[reason] || 0) + 1;
    }
    afterId = ids[ids.length - 1];
    if (ids.length < size) break;
  }
  return result;
}

module.exports = { TIMEOUT_NOTE, staleUnpaidDecision, cancelIfStale, cancelExpiredUnpaidOrders };
