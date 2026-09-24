'use strict';

const asyncHandler = require('../../utils/asyncHandler');
const ApiError = require('../../utils/ApiError');
const svc = require('../../services/admin.catalog.service');

exports.listProducts = asyncHandler(async (req, res) => {
  res.json(await svc.adminListProducts(req.query));
});

exports.getProduct = asyncHandler(async (req, res) => {
  res.json({ data: await svc.loadProduct(req.params.id) });
});

exports.createProduct = asyncHandler(async (req, res) => {
  res.status(201).json({ data: await svc.createProduct(req.body) });
});

exports.updateProduct = asyncHandler(async (req, res) => {
  res.json({ data: await svc.updateProduct(req.params.id, req.body) });
});

exports.deleteProduct = asyncHandler(async (req, res) => {
  await svc.deleteProduct(req.params.id);
  res.status(204).end();
});

exports.createCategory = asyncHandler(async (req, res) => {
  res.status(201).json({ data: await svc.createCategory(req.body) });
});

exports.createVariant = asyncHandler(async (req, res) => {
  res.status(201).json({ data: await svc.createVariant(req.params.id, req.body) });
});

exports.updateVariant = asyncHandler(async (req, res) => {
  res.json({ data: await svc.updateVariant(req.params.id, req.params.variantId, req.body) });
});

exports.deleteVariant = asyncHandler(async (req, res) => {
  await svc.deleteVariant(req.params.id, req.params.variantId);
  res.status(204).end();
});

exports.uploadImages = asyncHandler(async (req, res) => {
  if (!req.files || req.files.length === 0) {
    throw ApiError.badRequest('No images uploaded', 'no_files');
  }
  const variantId = req.body.variant_id ? Number(req.body.variant_id) : null;
  res.status(201).json({ data: await svc.addImages(req.params.id, req.files, { variant_id: variantId }) });
});

exports.deleteImage = asyncHandler(async (req, res) => {
  await svc.deleteImage(req.params.imageId);
  res.status(204).end();
});
