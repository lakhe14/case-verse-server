'use strict';

/**
 * Add the payment-confirmation integration to an existing local database.
 * This migration is deliberately additive and idempotent: it never drops
 * tables, changes orders, or resets users/roles.
 */
const { sequelize } = require('../config/database');
const db = require('../models');

async function main() {
  await sequelize.authenticate();
  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS order_payment_confirmations (
      id INT AUTO_INCREMENT PRIMARY KEY,
      order_id INT NOT NULL UNIQUE,
      method ENUM('advance_qr','whatsapp_cod') NOT NULL,
      advance_amount DECIMAL(10,2) NOT NULL DEFAULT 100,
      status ENUM('pending','proof_uploaded','approved','rejected','cod_pending','cod_confirmed') NOT NULL DEFAULT 'pending',
      proof_filename VARCHAR(255) NULL,
      admin_note VARCHAR(500) NULL,
      reviewed_by_staff_id INT NULL,
      reviewed_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      CONSTRAINT fk_payment_confirmation_order FOREIGN KEY (order_id) REFERENCES orders(id),
      CONSTRAINT fk_payment_confirmation_reviewer FOREIGN KEY (reviewed_by_staff_id) REFERENCES staff(id)
    ) ENGINE=InnoDB
  `);

  const [permission] = await db.Permission.findOrCreate({
    where: { key: 'manage_order_payments' },
    defaults: { key: 'manage_order_payments', label: 'Review advance-payment proofs and confirm COD orders' },
  });
  const roles = await db.Role.findAll({ where: { name: ['Super Admin', 'Order Manager'] } });
  for (const role of roles) await role.addPermission(permission);

  console.info(`Payment confirmation table is ready; permission assigned to: ${roles.map((role) => role.name).join(', ') || 'no matching roles'}.`);
  await sequelize.close();
}

main().catch(async (error) => {
  console.error(error.message);
  await sequelize.close().catch(() => {});
  process.exit(1);
});
