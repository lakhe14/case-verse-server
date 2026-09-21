'use strict';

const asyncHandler = require('../utils/asyncHandler');
const db = require('../models');
const ApiError = require('../utils/ApiError');
const catalog = require('../services/catalog.service');

exports.list = asyncHandler(async (req, res) => {
  const rows = await db.Wishlist.findAll({
    where: { user_id: req.auth.id },
    include: [
      {
        model: db.Product,
        as: 'product',
        include: catalog.productInclude,
      },
    ],
    order: [['added_at', 'DESC']],
  });
  res.json({
    data: rows.map((w) => ({
      id: w.id,
      added_at: w.added_at,
      product: w.product ? catalog.shapeProduct(w.product) : null,
    })),
  });
});

exports.add = asyncHandler(async (req, res) => {
  const product = await db.Product.findByPk(req.body.product_id);
  if (!product) throw ApiError.notFound('Product not found', 'product_not_found');
  const [row, created] = await db.Wishlist.findOrCreate({
    where: { user_id: req.auth.id, product_id: req.body.product_id },
    defaults: { user_id: req.auth.id, product_id: req.body.product_id },
  });
  res.status(created ? 201 : 200).json({ data: row });
});

exports.remove = asyncHandler(async (req, res) => {
  const deleted = await db.Wishlist.destroy({
    where: { user_id: req.auth.id, product_id: req.params.productId },
  });
  if (!deleted) throw ApiError.notFound('Not in wishlist', 'not_in_wishlist');
  res.status(204).end();
});
