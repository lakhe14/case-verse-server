'use strict';

/**
 * Adds the guest_order_idempotency table (guest checkout Idempotency-Key).
 * Idempotent: safe to run repeatedly. Usage: npm run db:migrate-guest-order-idempotency
 */
const { sequelize } = require('../config/database');

async function main() {
  await sequelize.authenticate();
  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS guest_order_idempotency (
      id                  INT AUTO_INCREMENT PRIMARY KEY,
      key_hash            CHAR(64) NOT NULL,
      request_fingerprint CHAR(64) NOT NULL,
      order_id            INT NULL,
      replay_token_sealed VARCHAR(255) NULL,
      created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at          DATETIME NOT NULL,
      UNIQUE KEY uq_guest_idem_key (key_hash),
      INDEX idx_guest_idem_expires (expires_at),
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
    ) ENGINE=InnoDB
  `);
  console.info('Guest order idempotency migration complete.');
  await sequelize.close();
}

main().catch(async (error) => {
  console.error(error.message);
  await sequelize.close().catch(() => {});
  process.exit(1);
});
