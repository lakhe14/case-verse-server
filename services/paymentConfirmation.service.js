'use strict';

const fs = require('fs');
const path = require('path');
const { Op } = require('sequelize');
const db = require('../models');
const env = require('../config/env');
const orderService = require('./order.service');
const inventory = require('./inventory.service');
const ApiError = require('../utils/ApiError');
const { proofDir } = require('../middleware/paymentProofUpload');
const { hashOpaqueToken } = require('../utils/tokens');

const includeOrder = [{ model: db.Order, as: 'order', where: { status: 'pending' }, required: true, include: [{ model: db.User, as: 'user', attributes: ['id', 'name', 'email'] }] }];

async function ownedConfirmation(userId, orderId, transaction) {
  const order = await db.Order.findOne({ where: { id: orderId, user_id: userId }, transaction });
  if (!order) throw ApiError.notFound('Order not found', 'order_not_found');
  return findOrCreateConfirmation(order, transaction);
}

/** Same resolution as ownedConfirmation, but ownership is a guest access token, not a signed-in user_id. The token alone determines the order — no order id is ever taken from the request. */
async function ownedConfirmationForGuest(token, transaction) {
  const tokenHash = hashOpaqueToken(token);
  const tokenRow = await db.GuestOrderToken.findOne({ where: { token_hash: tokenHash }, transaction });
  if (!tokenRow) throw ApiError.notFound('Order not found', 'order_not_found');
  const order = await db.Order.findOne({ where: { id: tokenRow.order_id, user_id: null }, transaction });
  if (!order) throw ApiError.notFound('Order not found', 'order_not_found');
  return findOrCreateConfirmation(order, transaction);
}

async function findOrCreateConfirmation(order, transaction) {
  let confirmation = await db.OrderPaymentConfirmation.findOne({ where: { order_id: order.id }, transaction });
  if (!confirmation) {
    confirmation = await db.OrderPaymentConfirmation.create({ order_id: order.id, method: 'advance_qr', advance_amount: env.payment.advanceAmount, status: 'pending' }, { transaction });
  }
  return { order, confirmation };
}

/* ------------------------- shared core (customer + guest) ------------------------- */

async function doUploadProof(order, confirmation, file, transaction) {
  if (order.status !== 'pending' || ['approved', 'cod_confirmed'].includes(confirmation.status)) {
    throw ApiError.badRequest('This order is not eligible for a new payment proof.', 'payment_not_eligible');
  }
  const oldFile = confirmation.proof_filename;
  // The customer may already have paid: from now on the order waits on staff,
  // so the hold has no deadline until staff approve or reject.
  await inventory.holdUntilReviewed(order.id, transaction);
  await confirmation.update({ method: 'advance_qr', status: 'proof_uploaded', proof_filename: file.filename, admin_note: null, reviewed_by_staff_id: null, reviewed_at: null }, { transaction });
  if (oldFile && oldFile !== file.filename) {
    const oldPath = path.join(proofDir, path.basename(oldFile));
    fs.promises.unlink(oldPath).catch(() => {});
  }
  return confirmation;
}

async function doRequestCod(order, confirmation, transaction) {
  if (order.status !== 'pending' || ['approved', 'cod_confirmed'].includes(confirmation.status)) {
    throw ApiError.badRequest('This order is not eligible for COD confirmation.', 'payment_not_eligible');
  }
  // A COD request is not a confirmation and no advance is paid: stock stays
  // reserved for the COD window (72 h), never deducted.
  await inventory.setHoldDeadline(order.id, 'cod', transaction);
  await confirmation.update({ method: 'whatsapp_cod', status: 'cod_pending', admin_note: null, reviewed_by_staff_id: null, reviewed_at: null }, { transaction });
  return confirmation;
}

/* ------------------------------- customer ------------------------------- */

async function uploadProof(userId, orderId, file) {
  if (!file) throw ApiError.badRequest('Select a payment screenshot first.', 'payment_proof_required');
  return db.sequelize.transaction(async (transaction) => {
    const { order, confirmation } = await ownedConfirmation(userId, orderId, transaction);
    return doUploadProof(order, confirmation, file, transaction);
  });
}

async function requestCod(userId, orderId) {
  return db.sequelize.transaction(async (transaction) => {
    const { order, confirmation } = await ownedConfirmation(userId, orderId, transaction);
    return doRequestCod(order, confirmation, transaction);
  });
}

/* --------------------------------- guest --------------------------------- */

async function uploadProofGuest(token, file) {
  if (!file) throw ApiError.badRequest('Select a payment screenshot first.', 'payment_proof_required');
  return db.sequelize.transaction(async (transaction) => {
    const { order, confirmation } = await ownedConfirmationForGuest(token, transaction);
    return doUploadProof(order, confirmation, file, transaction);
  });
}

async function requestCodGuest(token) {
  return db.sequelize.transaction(async (transaction) => {
    const { order, confirmation } = await ownedConfirmationForGuest(token, transaction);
    return doRequestCod(order, confirmation, transaction);
  });
}

/* --------------------------------- admin --------------------------------- */

async function listQueue({ status, page = 1, limit = 20 } = {}) {
  const where = status ? { status } : { status: { [Op.in]: ['proof_uploaded', 'cod_pending', 'rejected'] } };
  const { rows, count } = await db.OrderPaymentConfirmation.findAndCountAll({ where, include: includeOrder, order: [['updated_at', 'DESC']], limit, offset: (page - 1) * limit });
  const now = new Date();
  return {
    data: rows.map((row) => ({ ...row.get({ plain: true }), review_overdue: orderService.isReviewOverdue(row, now) })),
    pagination: { page, limit, total: count, pages: Math.ceil(count / limit) },
  };
}

async function review(id, action, staffId, note) {
  return db.sequelize.transaction(inventory.STOCK_TX, async (transaction) => {
    const confirmation = await db.OrderPaymentConfirmation.findByPk(id, { include: includeOrder, lock: transaction.LOCK.UPDATE, transaction });
    if (!confirmation) throw ApiError.notFound('Payment confirmation not found', 'payment_confirmation_not_found');
    if (confirmation.order.status !== 'pending') {
      throw ApiError.badRequest('Cancelled or fulfilled orders cannot be reviewed for payment.', 'payment_not_eligible');
    }
    if (!['proof_uploaded', 'cod_pending'].includes(confirmation.status)) throw ApiError.badRequest('This payment confirmation has already been reviewed.', 'payment_already_reviewed');
    const isCod = confirmation.status === 'cod_pending';
    if (action === 'approve') {
      // Confirmation is the only point where physical stock is deducted, exactly once.
      await inventory.commitForOrder(confirmation.order_id, transaction);
      await confirmation.update({ status: isCod ? 'cod_confirmed' : 'approved', reviewed_by_staff_id: staffId, reviewed_at: new Date(), admin_note: note || null }, { transaction });
      await orderService.transitionOrderStatus(
        confirmation.order_id,
        { status: 'processing', note: isCod ? 'COD confirmed by staff' : 'Advance payment verified' },
        staffId,
        transaction
      );
    } else {
      if (isCod) throw ApiError.badRequest('COD requests can only be confirmed.', 'invalid_payment_review');
      // Rejection is retryable: the customer gets a fresh retry window (60 min)
      // to upload a new proof, which removes the deadline again.
      await inventory.setHoldDeadline(confirmation.order_id, 'retry', transaction);
      await confirmation.update({ status: 'rejected', reviewed_by_staff_id: staffId, reviewed_at: new Date(), admin_note: note || 'Payment proof could not be verified.' }, { transaction });
    }
    return db.OrderPaymentConfirmation.findByPk(id, { include: includeOrder, transaction });
  });
}

async function proofPath(id) {
  const confirmation = await db.OrderPaymentConfirmation.findByPk(id);
  if (!confirmation?.proof_filename) throw ApiError.notFound('Payment proof not found', 'payment_proof_not_found');
  const filePath = path.join(proofDir, path.basename(confirmation.proof_filename));
  if (!fs.existsSync(filePath)) throw ApiError.notFound('Payment proof file not found', 'payment_proof_missing');
  return { filePath, filename: confirmation.proof_filename };
}

module.exports = { uploadProof, requestCod, uploadProofGuest, requestCodGuest, listQueue, review, proofPath };
