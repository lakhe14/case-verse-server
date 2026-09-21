'use strict';

const asyncHandler = require('../utils/asyncHandler');
const catalog = require('../services/catalog.service');

exports.list = asyncHandler(async (req, res) => {
  const data = await catalog.listCategories();
  res.json({ data });
});

exports.attributes = asyncHandler(async (req, res) => {
  const data = await catalog.getCategoryAttributes(req.params.id);
  res.json({ data });
});
