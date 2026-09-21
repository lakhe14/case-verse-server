'use strict';

const asyncHandler = require('../../utils/asyncHandler');
const analytics = require('../../services/analytics.service');

exports.overview = asyncHandler(async (req, res) => {
  res.json({ data: await analytics.overview() });
});

exports.dashboard = asyncHandler(async (req, res) => {
  res.json({ data: await analytics.dashboard({ periodDays: req.query.period_days }) });
});

exports.sales = asyncHandler(async (req, res) => {
  res.json({ data: await analytics.salesOverTime(req.query) });
});

exports.topProducts = asyncHandler(async (req, res) => {
  res.json({ data: await analytics.topProducts(req.query) });
});

exports.listCustomers = asyncHandler(async (req, res) => {
  res.json(await analytics.listCustomers(req.query));
});

exports.customerDetail = asyncHandler(async (req, res) => {
  const data = await analytics.customerDetail(req.params.id);
  if (!data) return res.status(404).json({ error: { message: 'Customer not found', code: 'not_found' } });
  res.json({ data });
});
