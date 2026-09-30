'use strict';

const asyncHandler = require('../utils/asyncHandler');
const orders = require('../services/order.service');

exports.track = asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ data: await orders.trackOrder(req.body) });
});
