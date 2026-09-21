'use strict';
// LOCAL DEVELOPMENT / TEST ONLY. Idempotently provisions documented test access.
const db = require('../models');
const { sequelize } = require('../config/database');
const env = require('../config/env');
const { hashPassword } = require('../services/password.service');

const normalize = (value) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
const pascal = (value) => value.replace(/[^a-zA-Z0-9]+(.)?/g, (_, c) => c ? c.toUpperCase() : '').replace(/^./, (c) => c.toUpperCase());
const requiredDevValue = (key) => {
  const value = process.env[key];
  if (!value) throw new Error(`Missing ${key}. Set it in server/.env for local development.`);
  return value;
};

async function upsertStaff({ name, email, password, role_id }) {
  const fields = { name, email, password_hash: await hashPassword(password), role_id, is_active: true };
  const existing = await db.Staff.findOne({ where: { email } });
  return existing ? [await existing.update(fields), 'updated'] : [await db.Staff.create(fields), 'created'];
}
async function main() {
  if (env.isProd) throw new Error('dev:reset-accounts is disabled in production.');
  sequelize.options.logging = false;
  await sequelize.authenticate();
  const roles = await db.Role.findAll({ include: [{ model: db.Permission, as: 'permissions' }], order: [['id', 'ASC']] });
  if (!roles.length) throw new Error('No staff roles exist. Run the normal seed/RBAC setup first.');
  const adminRole = roles.slice().sort((a, b) => b.permissions.length - a.permissions.length || /super admin|admin/i.test(b.name) - /super admin|admin/i.test(a.name))[0];
  const admin = {
    name: requiredDevValue('DEV_ADMIN_USERNAME'),
    email: requiredDevValue('DEV_ADMIN_EMAIL'),
    password: requiredDevValue('DEV_ADMIN_PASSWORD'),
  };
  const customer = {
    name: requiredDevValue('DEV_CUSTOMER_USERNAME'),
    email: requiredDevValue('DEV_CUSTOMER_EMAIL'),
    password: requiredDevValue('DEV_CUSTOMER_PASSWORD'),
  };
  const summary = [];
  const [adminStaff, adminStatus] = await upsertStaff({ ...admin, role_id: adminRole.id });
  summary.push([adminRole.name, adminStaff.email, adminStaff.name, adminStatus]);
  const customerFields = { name: customer.name, email: customer.email, password_hash: await hashPassword(customer.password), is_active: true };
  const oldCustomer = await db.User.findOne({ where: { email: customerFields.email } });
  const customerUser = oldCustomer ? await oldCustomer.update(customerFields) : await db.User.create(customerFields);
  summary.push(['Customer', customerUser.email, customerUser.name, oldCustomer ? 'updated' : 'created']);
  // LOCAL DEVELOPMENT ONLY: generated staff passwords are deterministic so each
  // existing role can be tested, and this script refuses to run in production.
  for (const role of roles.filter((role) => role.id !== adminRole.id)) {
    const key = normalize(role.name);
    const [staff, status] = await upsertStaff({ name: pascal(role.name), email: `caseverse_${key}@gmail.com`, password: `${key}123`, role_id: role.id });
    summary.push([role.name, staff.email, staff.name, status]);
  }
  // Preserve all historical accounts. Only superseded known seed staff are deactivated, never deleted.
  for (const email of ['product@caseverse.test', 'orders@caseverse.test', 'support@caseverse.test', 'admin@caseverse.test']) {
    const staff = await db.Staff.findOne({ where: { email } });
    if (staff && staff.email !== adminStaff.email) { await staff.update({ is_active: false }); summary.push(['retired dev staff', staff.email, staff.name, 'deactivated']); }
  }
  for (const [role, email, username, status] of summary) console.info(`${role} | ${email} | ${username} | ${status}`);
  console.info(`Admin permissions: ${adminRole.permissions.length}; roles provisioned: ${roles.length}`);
  await sequelize.close();
}
main().catch(async (error) => { console.error(error.message); await sequelize.close(); process.exitCode = 1; });
