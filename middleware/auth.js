'use strict';

const ApiError = require('../utils/ApiError');
const { verifyAccessToken } = require('../utils/tokens');
const { Staff, Role, Permission } = require('../models');

function extractBearer(req) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme === 'Bearer' && token) return token;
  return null;
}

/** Verifies the access token and attaches req.auth = { id, type, roleId? }. */
function requireAuth(req, res, next) {
  const token = extractBearer(req);
  if (!token) return next(ApiError.unauthorized('Missing bearer token', 'missing_token'));
  try {
    const decoded = verifyAccessToken(token);
    req.auth = { id: decoded.id, type: decoded.type, roleId: decoded.roleId };
    next();
  } catch (err) {
    next(err);
  }
}

/** Restrict a route to a token type ('customer' | 'staff'). */
function requireType(type) {
  return (req, res, next) => {
    if (!req.auth) return next(ApiError.unauthorized());
    if (req.auth.type !== type) {
      return next(ApiError.forbidden(`Requires ${type} account`, 'wrong_account_type'));
    }
    next();
  };
}

/**
 * Staff-only guard that checks the account's role has the given permission key.
 * Loads role + permissions once and caches on req.
 */
function requirePermission(key) {
  return async (req, res, next) => {
    try {
      if (!req.auth) return next(ApiError.unauthorized());
      if (req.auth.type !== 'staff') {
        return next(ApiError.forbidden('Requires staff account', 'wrong_account_type'));
      }

      if (!req.staff) {
        const staff = await Staff.findByPk(req.auth.id, {
          include: [{ model: Role, as: 'role', include: [{ model: Permission, as: 'permissions' }] }],
        });
        if (!staff || !staff.is_active) {
          return next(ApiError.forbidden('Staff account inactive', 'staff_inactive'));
        }
        req.staff = staff;
        req.staffPermissions = new Set((staff.role?.permissions || []).map((p) => p.key));
      }

      if (!req.staffPermissions.has(key)) {
        return next(ApiError.forbidden(`Missing permission: ${key}`, 'missing_permission'));
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { requireAuth, requireType, requirePermission };
