'use strict';

const { Op } = require('sequelize');
const db = require('../models');
const ApiError = require('../utils/ApiError');
const { hashPassword, verifyPassword } = require('./password.service');
const {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  generateOpaqueToken,
  hashOpaqueToken,
} = require('../utils/tokens');
const { sendPasswordResetEmail } = require('./email.service');

const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour

function issueTokens({ id, type, roleId }) {
  const payload = roleId ? { id, type, roleId } : { id, type };
  return {
    accessToken: signAccessToken(payload),
    refreshToken: signRefreshToken(payload),
  };
}

/* -------------------------------- Customer -------------------------------- */

async function registerCustomer({ name, email, password, phone }) {
  const existing = await db.User.findOne({ where: { email } });
  if (existing) throw ApiError.conflict('Email already registered', 'email_taken');

  const user = await db.User.create({
    name,
    email,
    phone: phone || null,
    password_hash: await hashPassword(password),
  });

  return { user: user.toSafeJSON(), ...issueTokens({ id: user.id, type: 'customer' }) };
}

async function loginCustomer({ email, password }) {
  const user = await db.User.findOne({ where: { email } });
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    throw ApiError.unauthorized('Invalid email or password', 'invalid_credentials');
  }
  if (!user.is_active) throw ApiError.forbidden('Account disabled', 'account_disabled');

  return { user: user.toSafeJSON(), ...issueTokens({ id: user.id, type: 'customer' }) };
}

/* --------------------------------- Staff ---------------------------------- */

async function loginStaff({ email, password }) {
  const staff = await db.Staff.findOne({
    where: { email },
    include: [{ model: db.Role, as: 'role', include: [{ model: db.Permission, as: 'permissions' }] }],
  });
  if (!staff || !(await verifyPassword(password, staff.password_hash))) {
    throw ApiError.unauthorized('Invalid email or password', 'invalid_credentials');
  }
  if (!staff.is_active) throw ApiError.forbidden('Account disabled', 'account_disabled');

  return {
    staff: {
      ...staff.toSafeJSON(),
      role: staff.role?.name,
      permissions: (staff.role?.permissions || []).map((p) => p.key),
    },
    ...issueTokens({ id: staff.id, type: 'staff', roleId: staff.role_id }),
  };
}

/* -------------------------------- Refresh -------------------------------- */

async function refresh({ refreshToken }) {
  let decoded;
  try {
    decoded = verifyRefreshToken(refreshToken);
  } catch (err) {
    throw ApiError.unauthorized('Invalid refresh token', 'invalid_token');
  }

  if (decoded.type === 'customer') {
    const user = await db.User.findByPk(decoded.id);
    if (!user || !user.is_active) throw ApiError.unauthorized('Account unavailable', 'account_unavailable');
    return issueTokens({ id: user.id, type: 'customer' });
  }
  if (decoded.type === 'staff') {
    const staff = await db.Staff.findByPk(decoded.id);
    if (!staff || !staff.is_active) throw ApiError.unauthorized('Account unavailable', 'account_unavailable');
    return issueTokens({ id: staff.id, type: 'staff', roleId: staff.role_id });
  }
  throw ApiError.unauthorized('Unknown token type', 'invalid_token');
}

/* --------------------------- Password reset ----------------------------- */

async function requestPasswordReset({ email }) {
  const user = await db.User.findOne({ where: { email } });
  // Do not leak whether the email exists.
  if (!user) return;

  const { raw, hash } = generateOpaqueToken();
  await db.PasswordReset.create({
    user_id: user.id,
    token_hash: hash,
    expires_at: new Date(Date.now() + RESET_TTL_MS),
  });
  await sendPasswordResetEmail(user, raw);
}

async function resetPassword({ token, password }) {
  const tokenHash = hashOpaqueToken(token);
  const record = await db.PasswordReset.findOne({
    where: { token_hash: tokenHash, used_at: { [Op.is]: null }, expires_at: { [Op.gt]: new Date() } },
    order: [['id', 'DESC']],
  });
  if (!record) throw ApiError.badRequest('Invalid or expired reset token', 'invalid_reset_token');

  await db.sequelize.transaction(async (t) => {
    const user = await db.User.findByPk(record.user_id, { transaction: t });
    if (!user) throw ApiError.badRequest('Invalid reset token', 'invalid_reset_token');
    user.password_hash = await hashPassword(password);
    await user.save({ transaction: t });
    record.used_at = new Date();
    await record.save({ transaction: t });
    // Invalidate any other outstanding tokens for this user.
    await db.PasswordReset.update(
      { used_at: new Date() },
      { where: { user_id: user.id, used_at: { [Op.is]: null } }, transaction: t }
    );
  });
}

module.exports = {
  registerCustomer,
  loginCustomer,
  loginStaff,
  refresh,
  requestPasswordReset,
  resetPassword,
};
