'use strict';

const asyncHandler = require('../../utils/asyncHandler');
const reviews = require('../../services/review.service');

exports.list = asyncHandler(async (req, res) => {
  res.json(await reviews.adminList(req.query));
});

exports.moderate = asyncHandler(async (req, res) => {
  res.json({ data: await reviews.moderate(req.params.id, req.body.status) });
});
