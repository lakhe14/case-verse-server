'use strict';

const asyncHandler = require('../utils/asyncHandler');
const loyalty = require('../services/loyalty.service');

exports.balance = asyncHandler(async (req, res) => {
  const points = await loyalty.getBalance(req.auth.id);
  res.json({ data: { points, value: loyalty.pointsToCurrency(points) } });
});

exports.transactions = asyncHandler(async (req, res) => {
  res.json(await loyalty.listTransactions(req.auth.id, req.query));
});
