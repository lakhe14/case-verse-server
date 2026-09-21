'use strict';

const asyncHandler = require('../utils/asyncHandler');
const reviews = require('../services/review.service');

exports.create = asyncHandler(async (req, res) => {
  res.status(201).json({ data: await reviews.createReview(req.auth.id, req.body) });
});

exports.listPublic = asyncHandler(async (req, res) => {
  res.json(await reviews.listApprovedPublic(req.query));
});

exports.listForProduct = asyncHandler(async (req, res) => {
  res.json(await reviews.listApprovedForProduct(req.params.productId, req.query));
});

exports.eligibility = asyncHandler(async (req, res) => {
  res.json({ data: await reviews.getReviewEligibility(req.auth.id, req.params.productId) });
});

exports.listMine = asyncHandler(async (req, res) => {
  res.json(await reviews.listMine(req.auth.id, req.query));
});
