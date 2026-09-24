'use strict';

/**
 * Adds coupon_usages.released_at: set when an order is cancelled before
 * payment confirmation, so that use no longer counts toward coupon limits.
 * Additive and idempotent. Existing rows stay NULL (still counted): orders
 * cancelled before this change are not re-examined or backfilled.
 * Usage: npm run db:migrate-coupon-usage-release
 */
const { sequelize } = require('../config/database');

async function main() {
  await sequelize.authenticate();
  const [columns] = await sequelize.query("SHOW COLUMNS FROM coupon_usages LIKE 'released_at'");
  if (!columns.length) {
    await sequelize.query('ALTER TABLE coupon_usages ADD COLUMN released_at DATETIME NULL AFTER used_at');
    console.info('Added coupon_usages.released_at.');
  }
  console.info('Coupon usage release migration complete.');
  await sequelize.close();
}

main().catch(async (error) => {
  console.error(error.message);
  await sequelize.close().catch(() => {});
  process.exit(1);
});
