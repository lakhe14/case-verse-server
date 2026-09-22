'use strict';

const asyncHandler = require('../utils/asyncHandler');
const fs = require('fs');
const orders = require('../services/order.service');
const payments = require('../services/paymentConfirmation.service');

exports.preview = asyncHandler(async (req, res) => {
  res.json({ data: await orders.previewGuestOrder(req.body) });
});

exports.place = asyncHandler(async (req, res) => {
  const { order, guest_token } = await orders.placeGuestOrder(req.body);
  // The raw token is returned exactly once, here, and never logged or stored.
  res.status(201).json({ data: order, guest_token });
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
