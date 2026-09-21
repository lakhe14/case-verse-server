'use strict';

const path = require('path');
const asyncHandler = require('../utils/asyncHandler');
const payments = require('../services/paymentConfirmation.service');

exports.uploadProof = asyncHandler(async (req, res) => {
  res.status(201).json({ data: await payments.uploadProof(req.auth.id, req.params.id, req.file) });
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
  res.type(path.extname(filename));
  res.sendFile(filePath);
});
