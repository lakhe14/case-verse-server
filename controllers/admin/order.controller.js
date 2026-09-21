'use strict';

const asyncHandler = require('../../utils/asyncHandler');
const orders = require('../../services/order.service');

exports.list = asyncHandler(async (req, res) => {
  res.json(await orders.adminListOrders(req.query));
});

exports.get = asyncHandler(async (req, res) => {
  res.json({ data: await orders.adminGetOrder(req.params.id) });
});

exports.updateStatus = asyncHandler(async (req, res) => {
  const data = await orders.updateOrderStatus(req.params.id, req.body, req.auth.id);
  res.json({ data });
});
