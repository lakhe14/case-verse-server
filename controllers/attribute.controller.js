'use strict';

const asyncHandler = require('../utils/asyncHandler');
const svc = require('../services/attribute.service');

// Public
exports.list = asyncHandler(async (req, res) => {
  res.json({ data: await svc.listAttributes() });
});

// Admin (manage_products)
exports.create = asyncHandler(async (req, res) => {
  res.status(201).json({ data: await svc.createAttribute(req.body) });
});

exports.rename = asyncHandler(async (req, res) => {
  res.json({ data: await svc.renameAttribute(req.params.id, req.body) });
});

exports.remove = asyncHandler(async (req, res) => {
  await svc.deleteAttribute(req.params.id);
  res.status(204).end();
});

exports.listCategories = asyncHandler(async (req, res) => {
  res.json({ data: await svc.listCategoriesWithAttributes() });
});

exports.setCategoryAttributes = asyncHandler(async (req, res) => {
  const data = await svc.setCategoryAttributes(req.params.id, req.body.attribute_ids);
  res.json({ data });
});
