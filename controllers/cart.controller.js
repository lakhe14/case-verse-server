'use strict';

const asyncHandler = require('../utils/asyncHandler');
const cart = require('../services/cart.service');

exports.get = asyncHandler(async (req, res) => {
  res.json({ data: await cart.getCart(req.auth.id) });
});

exports.addItem = asyncHandler(async (req, res) => {
  res.status(201).json({ data: await cart.addItem(req.auth.id, req.body) });
});

exports.updateItem = asyncHandler(async (req, res) => {
  res.json({ data: await cart.updateItem(req.auth.id, req.params.id, req.body) });
});

exports.removeItem = asyncHandler(async (req, res) => {
  res.json({ data: await cart.removeItem(req.auth.id, req.params.id) });
});

exports.clear = asyncHandler(async (req, res) => {
  await cart.clearCart(req.auth.id);
  res.json({ data: await cart.getCart(req.auth.id) });
});
