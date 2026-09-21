'use strict';

const fs = require('fs');
const path = require('path');
const { Op } = require('sequelize');
const db = require('../models');
const env = require('../config/env');
const orderService = require('./order.service');
const ApiError = require('../utils/ApiError');
const { proofDir } = require('../middleware/paymentProofUpload');

const includeOrder = [{ model: db.Order, as: 'order', include: [{ model: db.User, as: 'user', attributes: ['id', 'name', 'email'] }] }];

async function ownedConfirmation(userId, orderId, transaction) {
  const order = await db.Order.findOne({ where: { id: orderId, user_id: userId }, transaction });
  if (!order) throw ApiError.notFound('Order not found', 'order_not_found');
  let confirmation = await db.OrderPaymentConfirmation.findOne({ where: { order_id: order.id }, transaction });
  if (!confirmation) {
    confirmation = await db.OrderPaymentConfirmation.create({ order_id: order.id, method: 'advance_qr', advance_amount: env.payment.advanceAmount, status: 'pending' }, { transaction });
  }
  return { order, confirmation };
}

async function uploadProof(userId, orderId, file) {
  if (!file) throw ApiError.badRequest('Select a payment screenshot first.', 'payment_proof_required');
  return db.sequelize.transaction(async (transaction) => {
    const { order, confirmation } = await ownedConfirmation(userId, orderId, transaction);
    if (order.status !== 'pending' || ['approved', 'cod_confirmed'].includes(confirmation.status)) {
      throw ApiError.badRequest('This order is not eligible for a new payment proof.', 'payment_not_eligible');
    }
    const oldFile = confirmation.proof_filename;
    await confirmation.update({ method: 'advance_qr', status: 'proof_uploaded', proof_filename: file.filename, admin_note: null, reviewed_by_staff_id: null, reviewed_at: null }, { transaction });
    if (oldFile && oldFile !== file.filename) {
      const oldPath = path.join(proofDir, path.basename(oldFile));
      fs.promises.unlink(oldPath).catch(() => {});
    }
    return confirmation;
  });
}

async function requestCod(userId, orderId) {
  return db.sequelize.transaction(async (transaction) => {
    const { order, confirmation } = await ownedConfirmation(userId, orderId, transaction);
    if (order.status !== 'pending' || ['approved', 'cod_confirmed'].includes(confirmation.status)) {
      throw ApiError.badRequest('This order is not eligible for COD confirmation.', 'payment_not_eligible');
    }
    await confirmation.update({ method: 'whatsapp_cod', status: 'cod_pending', admin_note: null, reviewed_by_staff_id: null, reviewed_at: null }, { transaction });
    return confirmation;
  });
}

async function listQueue({ status, page = 1, limit = 20 } = {}) {
  const where = status ? { status } : { status: { [Op.in]: ['proof_uploaded', 'cod_pending', 'rejected'] } };
  const { rows, count } = await db.OrderPaymentConfirmation.findAndCountAll({ where, include: includeOrder, order: [['updated_at', 'DESC']], limit, offset: (page - 1) * limit });
  return { data: rows.map((row) => row.get({ plain: true })), pagination: { page, limit, total: count, pages: Math.ceil(count / limit) } };
}

async function review(id, action, staffId, note) {
  return db.sequelize.transaction(async (transaction) => {
    const confirmation = await db.OrderPaymentConfirmation.findByPk(id, { include: includeOrder, lock: transaction.LOCK.UPDATE, transaction });
    if (!confirmation) throw ApiError.notFound('Payment confirmation not found', 'payment_confirmation_not_found');
    if (!['proof_uploaded', 'cod_pending'].includes(confirmation.status)) throw ApiError.badRequest('This payment confirmation has already been reviewed.', 'payment_already_reviewed');
    const isCod = confirmation.status === 'cod_pending';
    if (action === 'approve') {
      await confirmation.update({ status: isCod ? 'cod_confirmed' : 'approved', reviewed_by_staff_id: staffId, reviewed_at: new Date(), admin_note: note || null }, { transaction });
      await orderService.transitionOrderStatus(
        confirmation.order_id,
        { status: 'processing', note: isCod ? 'COD confirmed by staff' : 'Advance payment verified' },
        staffId,
        transaction
      );
    } else {
      if (isCod) throw ApiError.badRequest('COD requests can only be confirmed.', 'invalid_payment_review');
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

module.exports = { uploadProof, requestCod, listQueue, review, proofPath };
