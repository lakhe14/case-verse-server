'use strict';

const asyncHandler = require('../../utils/asyncHandler');
const svc = require('../../services/admin.staff.service');

exports.listStaff = asyncHandler(async (req, res) => {
  res.json({ data: await svc.listStaff() });
});

exports.createStaff = asyncHandler(async (req, res) => {
  res.status(201).json({ data: await svc.createStaff(req.body) });
});

exports.updateStaff = asyncHandler(async (req, res) => {
  res.json({ data: await svc.updateStaff(req.params.id, req.body) });
});

exports.deleteStaff = asyncHandler(async (req, res) => {
  await svc.deleteStaff(req.params.id);
  res.status(204).end();
});

exports.listRoles = asyncHandler(async (req, res) => {
  res.json({ data: await svc.listRoles() });
});

exports.createRole = asyncHandler(async (req, res) => {
  res.status(201).json({ data: await svc.createRole(req.body) });
});

exports.listPermissions = asyncHandler(async (req, res) => {
  res.json({ data: await svc.listPermissions() });
});

exports.setRolePermissions = asyncHandler(async (req, res) => {
  res.json({ data: await svc.setRolePermissions(req.params.id, req.body.permissionKeys) });
});
