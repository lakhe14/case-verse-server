'use strict';

/**
 * Indexes for transactional coupon redemption on coupon_usages:
 *   idx_coupon_usage_active (coupon_id, user_id, released_at)
 *     serves both limit counts under the coupon lock: active uses of a coupon
 *     (coupon_id prefix) and active uses by one customer (all three columns).
 *     It replaces the single-column FK index on coupon_id.
 *   uq_coupon_usage_order (order_id)
 *     an order carries at most one coupon (orders.coupon_id), so it can hold at
 *     most one use row. Replaces the single-column FK index on order_id.
 * Additive and idempotent. The unique key is skipped (and reported) if
 * existing data already has an order with several use rows; nothing is
 * deleted or rewritten. Usage: npm run db:migrate-coupon-usage-indexes
 */
const { sequelize } = require('../config/database');

async function indexes() {
  const [rows] = await sequelize.query('SHOW INDEX FROM coupon_usages');
  const byName = new Map();
  for (const row of rows) byName.set(row.Key_name, [...(byName.get(row.Key_name) || []), row.Column_name]);
  return byName;
}

/** Drops a single-column FK index once another index leads with that column. */
async function dropRedundant(name, column) {
  const current = await indexes();
  const single = current.get(name);
  const covered = [...current.entries()].some(([key, cols]) => key !== name && cols[0] === column);
  if (single && single.length === 1 && single[0] === column && covered) {
    await sequelize.query(`ALTER TABLE coupon_usages DROP INDEX \`${name}\``);
    console.info(`Dropped redundant index ${name}.`);
  }
}

async function main() {
  await sequelize.authenticate();
  let current = await indexes();
  if (!current.has('idx_coupon_usage_active')) {
    await sequelize.query('ALTER TABLE coupon_usages ADD INDEX idx_coupon_usage_active (coupon_id, user_id, released_at)');
    console.info('Added idx_coupon_usage_active.');
  }
  current = await indexes();
  if (!current.has('uq_coupon_usage_order')) {
    const [[dup]] = await sequelize.query('SELECT COUNT(*) AS n FROM (SELECT order_id FROM coupon_usages GROUP BY order_id HAVING COUNT(*) > 1) d');
    if (Number(dup.n) > 0) {
      console.warn(`Skipped uq_coupon_usage_order: ${dup.n} order(s) already have several coupon use rows. Review them manually.`);
    } else {
      await sequelize.query('ALTER TABLE coupon_usages ADD UNIQUE KEY uq_coupon_usage_order (order_id)');
      console.info('Added uq_coupon_usage_order.');
    }
  }
  await dropRedundant('coupon_id', 'coupon_id');
  await dropRedundant('order_id', 'order_id');
  console.info('Coupon usage index migration complete.');
  await sequelize.close();
}

main().catch(async (error) => {
  console.error(error.message);
  await sequelize.close().catch(() => {});
  process.exit(1);
});
