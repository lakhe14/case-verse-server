'use strict';

/**
 * Payment proofs awaiting staff review hold stock without a deadline:
 * inventory_reservations.expires_at becomes nullable (NULL = held until staff
 * review), and still-live holds of orders whose proof is already awaiting
 * review lose their deadline. Lapsed holds are left as they are (their stock
 * may have been sold; approval re-validates them). Stock values and order
 * statuses are not touched. Idempotent.
 * Usage: npm run db:migrate-review-holds
 */
const { sequelize } = require('../config/database');

async function main() {
  await sequelize.authenticate();
  const [[column]] = await sequelize.query("SHOW COLUMNS FROM inventory_reservations LIKE 'expires_at'");
  if (column.Null !== 'YES') {
    await sequelize.query('ALTER TABLE inventory_reservations MODIFY expires_at DATETIME NULL');
    console.info('inventory_reservations.expires_at is now nullable.');
  }
  const [result] = await sequelize.query(`
    UPDATE inventory_reservations r
    JOIN order_payment_confirmations p ON p.order_id = r.order_id AND p.status = 'proof_uploaded'
    JOIN orders o ON o.id = r.order_id AND o.status = 'pending'
    SET r.expires_at = NULL
    WHERE r.status = 'active' AND r.expires_at > UTC_TIMESTAMP()
  `);
  console.info(`Review holds without a deadline: ${result.affectedRows || 0} row(s) updated.`);
  console.info('Review holds migration complete.');
  await sequelize.close();
}

main().catch(async (error) => {
  console.error(error.message);
  await sequelize.close().catch(() => {});
  process.exit(1);
});
