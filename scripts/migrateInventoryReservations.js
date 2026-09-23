'use strict';

/**
 * Adds inventory_reservations (reserve on order, deduct on payment confirmation).
 * Additive and idempotent. Does NOT create reservations for existing orders:
 * orders placed before this change were already deducted at placement and keep
 * that legacy behaviour (see services/inventory.service.js).
 * Usage: npm run db:migrate-inventory-reservations
 */
const { sequelize } = require('../config/database');

async function main() {
  await sequelize.authenticate();
  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS inventory_reservations (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      order_id    INT NOT NULL,
      variant_id  INT NOT NULL,
      quantity    INT NOT NULL,
      status      ENUM('active','committed','released','expired','restocked') NOT NULL DEFAULT 'active',
      created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      expires_at  DATETIME NOT NULL,
      UNIQUE KEY uq_reservation_order_variant (order_id, variant_id),
      INDEX idx_reservation_availability (variant_id, status, expires_at),
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
      FOREIGN KEY (variant_id) REFERENCES product_variants(id)
    ) ENGINE=InnoDB
  `);
  console.info('Inventory reservations migration complete.');
  await sequelize.close();
}

main().catch(async (error) => {
  console.error(error.message);
  await sequelize.close().catch(() => {});
  process.exit(1);
});
