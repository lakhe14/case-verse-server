'use strict';

const path = require('path');
const fs = require('fs');
const asyncHandler = require('../utils/asyncHandler');
const payments = require('../services/paymentConfirmation.service');

exports.uploadProof = asyncHandler(async (req, res) => {
  try {
    res.status(201).json({ data: await payments.uploadProof(req.auth.id, req.params.id, req.file) });
  } catch (error) {
    // Multer stores the file before the ownership/eligibility check. Never leave
    // an orphaned private upload when that business check rejects the request.
    if (req.file?.path) await fs.promises.unlink(req.file.path).catch(() => {});
    throw error;
  }
});
exports.requestCod = asyncHandler(async (req, res) => {
  res.json({ data: await payments.requestCod(req.auth.id, req.params.id) });
});
exports.listQueue = asyncHandler(async (req, res) => {
  res.json(await payments.listQueue(req.query));
});
exports.approve = asyncHandler(async (req, res) => {
  res.json({ data: await payments.review(req.params.id, 'approve', req.auth.id, req.body.note) });
});
exports.reject = asyncHandler(async (req, res) => {
  res.json({ data: await payments.review(req.params.id, 'reject', req.auth.id, req.body.note) });
});
exports.proof = asyncHandler(async (req, res) => {
  const { filePath, filename } = await payments.proofPath(req.params.id);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Disposition', 'inline; filename="payment-proof"');
  res.type(path.extname(filename));
  res.sendFile(filePath);
});
