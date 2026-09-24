'use strict';

/**
 * Creates the first Super Admin staff account for a new deployment.
 *
 *   BOOTSTRAP_ADMIN_NAME=... BOOTSTRAP_ADMIN_EMAIL=... BOOTSTRAP_ADMIN_PASSWORD=... \
 *     npm run staff:bootstrap-admin
 *
 * - reads credentials only from the environment (set them for this one run,
 *   never in a committed file); nothing is printed except the email's domain
 * - refuses weak passwords: at least 14 characters, three of lower / upper /
 *   digit / symbol, and none of the name, email, "caseverse" or "password"
 * - refuses to run once any active Super Admin exists (use the admin UI to
 *   add staff after that); re-running for the same email is a no-op that
 *   never changes its password
 * Requires RBAC (npm run db:seed-rbac) first.
 */

const db = require('../models');
const { hashPassword } = require('../services/password.service');

const SUPER_ADMIN = 'Super Admin';

function passwordProblems(password, { name, email }) {
  const problems = [];
  if (password.length < 14) problems.push('at least 14 characters');
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  if (classes < 3) problems.push('three of: lowercase, uppercase, digit, symbol');
  const lowered = password.toLowerCase();
  const words = ['caseverse', 'password', 'admin123', 'qwerty', email.split('@')[0].toLowerCase(), ...name.toLowerCase().split(/\s+/)];
  if (words.some((word) => word.length >= 3 && lowered.includes(word))) problems.push('no name, email, "caseverse" or common words');
  return problems;
}

async function main() {
  const name = (process.env.BOOTSTRAP_ADMIN_NAME || '').trim();
  const email = (process.env.BOOTSTRAP_ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD || '';
  if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !password) {
    throw new Error('Set BOOTSTRAP_ADMIN_NAME, BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD for this run.');
  }
  const problems = passwordProblems(password, { name, email });
  if (problems.length) throw new Error(`Password too weak: ${problems.join('; ')}.`);

  db.sequelize.options.logging = false;
  await db.sequelize.authenticate();
  const role = await db.Role.findOne({ where: { name: SUPER_ADMIN } });
  if (!role) throw new Error('Super Admin role missing. Run npm run db:seed-rbac first.');

  const existing = await db.Staff.findOne({ where: { email } });
  if (existing && existing.role_id === role.id && existing.is_active) {
    console.info(`Super Admin for @${email.split('@')[1]} already exists; nothing changed.`);
    return;
  }
  const admins = await db.Staff.count({ where: { role_id: role.id, is_active: true } });
  if (admins > 0) throw new Error('An active Super Admin already exists. Add further staff from the admin UI.');
  if (existing) throw new Error('A staff account with this email exists but is not an active Super Admin. Resolve it in the admin UI.');

  await db.Staff.create({ name, email, password_hash: await hashPassword(password), role_id: role.id, is_active: true });
  console.info(`Super Admin created for @${email.split('@')[1]}. Unset BOOTSTRAP_ADMIN_PASSWORD now.`);
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    })
    .finally(() => db.sequelize.close());
}

module.exports = { passwordProblems };
