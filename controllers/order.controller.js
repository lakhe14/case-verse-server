'use strict';

const asyncHandler = require('../utils/asyncHandler');
const orders = require('../services/order.service');

exports.preview = asyncHandler(async (req, res) => {
  res.json({ data: await orders.previewOrder(req.auth.id, req.body) });
});

exports.place = asyncHandler(async (req, res) => {
  res.status(201).json({ data: await orders.placeOrder(req.auth.id, req.body) });
});

exports.listMine = asyncHandler(async (req, res) => {
  res.json(await orders.listUserOrders(req.auth.id, req.query));
});

exports.getMine = asyncHandler(async (req, res) => {
  res.json({ data: await orders.getUserOrder(req.auth.id, req.params.id) });
});
