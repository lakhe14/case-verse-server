'use strict';

const asyncHandler = require('../utils/asyncHandler');
const authService = require('../services/auth.service');

exports.register = asyncHandler(async (req, res) => {
  const result = await authService.registerCustomer(req.body);
  res.status(201).json(result);
});

exports.login = asyncHandler(async (req, res) => {
  const result = await authService.loginCustomer(req.body);
  res.json(result);
});

exports.staffLogin = asyncHandler(async (req, res) => {
  const result = await authService.loginStaff(req.body);
  res.json(result);
});

exports.refresh = asyncHandler(async (req, res) => {
  const result = await authService.refresh(req.body);
  res.json(result);
});

exports.logout = asyncHandler(async (req, res) => {
  // Stateless JWT: client discards tokens. Endpoint exists for symmetry and
  // future refresh-token revocation lists.
  res.status(204).end();
});

exports.forgotPassword = asyncHandler(async (req, res) => {
  await authService.requestPasswordReset(req.body);
  res.json({ message: 'If that email exists, a reset link has been sent.' });
});

exports.resetPassword = asyncHandler(async (req, res) => {
  await authService.resetPassword(req.body);
  res.json({ message: 'Password updated. You can now log in.' });
});

exports.me = asyncHandler(async (req, res) => {
  const db = require('../models');
  if (req.auth.type === 'customer') {
    const user = await db.User.findByPk(req.auth.id);
    return res.json({ type: 'customer', user: user ? user.toSafeJSON() : null });
  }
  const staff = await db.Staff.findByPk(req.auth.id, {
    include: [{ model: db.Role, as: 'role', include: [{ model: db.Permission, as: 'permissions' }] }],
  });
  res.json({
    type: 'staff',
    staff: staff
      ? {
          ...staff.toSafeJSON(),
          role: staff.role?.name,
          permissions: (staff.role?.permissions || []).map((p) => p.key),
        }
      : null,
  });
});
