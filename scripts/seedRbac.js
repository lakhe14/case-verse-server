'use strict';

/**
 * Production-safe seed: staff roles and permissions only. Idempotent.
 * Unlike `npm run db:seed` (development), it adds no demo catalog, coupons,
 * shipping rows or placeholder store settings.
 * Usage: npm run db:seed-rbac
 */

const db = require('../models');
const { seedRbac, ROLES } = require('./seed');

async function main() {
  db.sequelize.options.logging = false;
  await db.sequelize.authenticate();
  await seedRbac();
  console.info(`RBAC ready: ${Object.keys(ROLES).join(', ')}`);
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => db.sequelize.close());
