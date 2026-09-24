'use strict';

/**
 * Adds orders.cancellation_reason (customer | guest | staff | payment_timeout).
 * Additive and idempotent. Existing orders keep NULL: their cancellation source
 * was never recorded, and this migration cancels nothing.
 * Usage: npm run db:migrate-order-cancellation-reason
 */
const { sequelize } = require('../config/database');

async function main() {
  await sequelize.authenticate();
  const [columns] = await sequelize.query("SHOW COLUMNS FROM orders LIKE 'cancellation_reason'");
  if (!columns.length) {
    await sequelize.query('ALTER TABLE orders ADD COLUMN cancellation_reason VARCHAR(40) NULL AFTER billing_address_id');
    console.info('Added orders.cancellation_reason.');
  }
  console.info('Order cancellation reason migration complete.');
  await sequelize.close();
}

main().catch(async (error) => {
  console.error(error.message);
  await sequelize.close().catch(() => {});
  process.exit(1);
});
