'use strict';

const asyncHandler = require('../utils/asyncHandler');
const fs = require('fs');
const orders = require('../services/order.service');
const payments = require('../services/paymentConfirmation.service');

exports.preview = asyncHandler(async (req, res) => {
  res.json({ data: await orders.previewGuestOrder(req.body) });
});

exports.place = asyncHandler(async (req, res) => {
  const { order, guest_token, replayed } = await orders.placeGuestOrder(req.body, { idempotencyKey: req.get('Idempotency-Key') });
  // The raw token is never logged. A replay of the same Idempotency-Key returns
  // the same order and recovered token with 200 instead of 201.
  if (replayed) res.set('Idempotent-Replayed', 'true');
  res.status(replayed ? 200 : 201).json({ data: order, guest_token });
});

exports.get = asyncHandler(async (req, res) => {
  res.json({ data: await orders.getGuestOrder(req.params.token) });
});

exports.cancel = asyncHandler(async (req, res) => {
  res.json({ data: await orders.cancelGuestOrder(req.params.token) });
});

exports.uploadProof = asyncHandler(async (req, res) => {
  try {
    res.json({ data: await payments.uploadProofGuest(req.params.token, req.file) });
  } catch (error) {
    // Multer writes before token ownership is checked; remove rejected files.
    if (req.file?.path) await fs.promises.unlink(req.file.path).catch(() => {});
    throw error;
  }
});

exports.requestCod = asyncHandler(async (req, res) => {
  res.json({ data: await payments.requestCodGuest(req.params.token) });
});
