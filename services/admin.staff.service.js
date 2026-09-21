'use strict';

const db = require('../models');
const ApiError = require('../utils/ApiError');
const { hashPassword } = require('./password.service');

async function listStaff() {
  return db.Staff.findAll({
    attributes: ['id', 'name', 'email', 'role_id', 'is_active', 'created_at'],
    include: [{ model: db.Role, as: 'role' }],
    order: [['id', 'ASC']],
  });
}

async function createStaff({ name, email, password, role_id }) {
  const role = await db.Role.findByPk(role_id);
  if (!role) throw ApiError.badRequest('Role not found', 'role_not_found');
  const existing = await db.Staff.findOne({ where: { email } });
  if (existing) throw ApiError.conflict('Email already in use', 'email_taken');
  const staff = await db.Staff.create({
    name,
    email,
    role_id,
    password_hash: await hashPassword(password),
  });
  return staff.toSafeJSON();
}

async function updateStaff(staffId, payload) {
  const staff = await db.Staff.findByPk(staffId);
  if (!staff) throw ApiError.notFound('Staff not found', 'staff_not_found');
  if (payload.role_id) {
    const role = await db.Role.findByPk(payload.role_id);
    if (!role) throw ApiError.badRequest('Role not found', 'role_not_found');
  }
  const patch = {
    name: payload.name ?? staff.name,
    role_id: payload.role_id ?? staff.role_id,
    is_active: payload.is_active ?? staff.is_active,
  };
  if (payload.password) patch.password_hash = await hashPassword(payload.password);
  await staff.update(patch);
  return staff.toSafeJSON();
}

async function deleteStaff(staffId) {
  const staff = await db.Staff.findByPk(staffId);
  if (!staff) throw ApiError.notFound('Staff not found', 'staff_not_found');
  await staff.destroy();
}

async function listRoles() {
  return db.Role.findAll({
    include: [{ model: db.Permission, as: 'permissions' }],
    order: [['id', 'ASC']],
  });
}

async function listPermissions() {
  return db.Permission.findAll({ order: [['key', 'ASC']] });
}

async function setRolePermissions(roleId, permissionKeys) {
  const role = await db.Role.findByPk(roleId);
  if (!role) throw ApiError.notFound('Role not found', 'role_not_found');
  const perms = await db.Permission.findAll({ where: { key: permissionKeys } });
  await role.setPermissions(perms);
  return db.Role.findByPk(roleId, { include: [{ model: db.Permission, as: 'permissions' }] });
}

async function createRole({ name, permissionKeys = [] }) {
  const existing = await db.Role.findOne({ where: { name } });
  if (existing) throw ApiError.conflict('Role already exists', 'role_exists');
  const role = await db.Role.create({ name });
  if (permissionKeys.length) {
    const perms = await db.Permission.findAll({ where: { key: permissionKeys } });
    await role.setPermissions(perms);
  }
  return db.Role.findByPk(role.id, { include: [{ model: db.Permission, as: 'permissions' }] });
}

module.exports = {
  listStaff,
  createStaff,
  updateStaff,
  deleteStaff,
  listRoles,
  listPermissions,
  setRolePermissions,
  createRole,
};
