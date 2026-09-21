'use strict';

const asyncHandler = require('../utils/asyncHandler');
const catalog = require('../services/catalog.service');

exports.list = asyncHandler(async (req, res) => {
  const result = await catalog.listProducts(req.query);
  res.json(result);
});

exports.getBySlug = asyncHandler(async (req, res) => {
  const data = await catalog.getProductBySlug(req.params.slug);
  res.json({ data });
});

exports.bestsellers = asyncHandler(async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 8, 1), 24);
  const data = await catalog.listBestsellers({ limit });
  res.json({ data });
});
