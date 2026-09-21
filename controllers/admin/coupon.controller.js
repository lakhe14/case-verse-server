'use strict';

const asyncHandler = require('../../utils/asyncHandler');
const svc = require('../../services/admin.coupon.service');

exports.list = asyncHandler(async (req, res) => {
  res.json(await svc.list(req.query));
});

exports.create = asyncHandler(async (req, res) => {
  res.status(201).json({ data: await svc.create(req.body) });
});

exports.update = asyncHandler(async (req, res) => {
  res.json({ data: await svc.update(req.params.id, req.body) });
});

exports.remove = asyncHandler(async (req, res) => {
  await svc.remove(req.params.id);
  res.status(204).end();
});
