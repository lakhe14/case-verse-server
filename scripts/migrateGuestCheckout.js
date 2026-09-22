'use strict';

/**
 * Additive, idempotent migration for guest checkout:
 *  - orders.user_id / shipping_address_id / billing_address_id relaxed to
 *    nullable (a guest order has none of the three)
 *  - orders.guest_* snapshot columns (name, phone, delivery fields, coords)
 *  - guest_order_tokens table (hash-only secure access token per order)
 *
 * Never touches existing rows: every authenticated historical order keeps
 * user_id/shipping_address_id/billing_address_id set exactly as before.
 */
const { sequelize } = require('../config/database');

async function addColumnIfMissing(table, column, ddl) {
  const [rows] = await sequelize.query(`SHOW COLUMNS FROM ${table} LIKE '${column}'`);
  if (!rows.length) await sequelize.query(ddl);
}

async function main() {
  await sequelize.authenticate();

  await sequelize.query('ALTER TABLE orders MODIFY COLUMN user_id INT NULL');
  await sequelize.query('ALTER TABLE orders MODIFY COLUMN shipping_address_id INT NULL');
  await sequelize.query('ALTER TABLE orders MODIFY COLUMN billing_address_id INT NULL');

  await addColumnIfMissing('orders', 'guest_name', "ALTER TABLE orders ADD COLUMN guest_name VARCHAR(120) NULL AFTER user_id");
  await addColumnIfMissing('orders', 'guest_phone', "ALTER TABLE orders ADD COLUMN guest_phone VARCHAR(20) NULL AFTER guest_name");
  await addColumnIfMissing('orders', 'guest_province', "ALTER TABLE orders ADD COLUMN guest_province VARCHAR(100) NULL AFTER guest_phone");
  await addColumnIfMissing('orders', 'guest_district', "ALTER TABLE orders ADD COLUMN guest_district VARCHAR(100) NULL AFTER guest_province");
  await addColumnIfMissing('orders', 'guest_municipality', "ALTER TABLE orders ADD COLUMN guest_municipality VARCHAR(150) NULL AFTER guest_district");
  await addColumnIfMissing('orders', 'guest_area', "ALTER TABLE orders ADD COLUMN guest_area VARCHAR(255) NULL AFTER guest_municipality");
  await addColumnIfMissing('orders', 'guest_landmark', "ALTER TABLE orders ADD COLUMN guest_landmark VARCHAR(255) NULL AFTER guest_area");
  await addColumnIfMissing('orders', 'guest_delivery_notes', "ALTER TABLE orders ADD COLUMN guest_delivery_notes VARCHAR(500) NULL AFTER guest_landmark");
  await addColumnIfMissing('orders', 'guest_latitude', "ALTER TABLE orders ADD COLUMN guest_latitude DECIMAL(10,7) NULL AFTER guest_delivery_notes");
  await addColumnIfMissing('orders', 'guest_longitude', "ALTER TABLE orders ADD COLUMN guest_longitude DECIMAL(10,7) NULL AFTER guest_latitude");

  const [tables] = await sequelize.query("SHOW TABLES LIKE 'guest_order_tokens'");
  if (!tables.length) {
    await sequelize.query(`
      CREATE TABLE guest_order_tokens (
        id INT AUTO_INCREMENT PRIMARY KEY,
        order_id INT NOT NULL UNIQUE,
        token_hash VARCHAR(255) NOT NULL UNIQUE,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
      ) ENGINE=InnoDB
    `);
  }

  console.info('Guest checkout migration complete.');
  await sequelize.close();
}

main().catch(async (error) => {
  console.error(error.message);
  await sequelize.close().catch(() => {});
  process.exit(1);
});
