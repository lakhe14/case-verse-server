'use strict';

/**
 * Additive, idempotent migration for the Dashain campaign:
 *  - orders.campaign_code / orders.campaign_name_snap (snapshot columns)
 *  - order_promo_items table (free-item snapshots, e.g. the suction holder)
 *
 * Never touches existing rows. Historical orders simply keep
 * campaign_code/campaign_name_snap as NULL, which is correct — they were
 * placed before any campaign existed.
 */
const { sequelize } = require('../config/database');

async function main() {
  await sequelize.authenticate();

  const [codeCol] = await sequelize.query("SHOW COLUMNS FROM orders LIKE 'campaign_code'");
  if (!codeCol.length) {
    await sequelize.query('ALTER TABLE orders ADD COLUMN campaign_code VARCHAR(40) NULL AFTER bundle_discount_amount');
  }
  const [nameCol] = await sequelize.query("SHOW COLUMNS FROM orders LIKE 'campaign_name_snap'");
  if (!nameCol.length) {
    await sequelize.query('ALTER TABLE orders ADD COLUMN campaign_name_snap VARCHAR(150) NULL AFTER campaign_code');
  }

  const [tables] = await sequelize.query("SHOW TABLES LIKE 'order_promo_items'");
  if (!tables.length) {
    await sequelize.query(`
      CREATE TABLE order_promo_items (
        id INT AUTO_INCREMENT PRIMARY KEY,
        order_id INT NOT NULL,
        sku_snap VARCHAR(64) NOT NULL,
        name_snap VARCHAR(200) NOT NULL,
        quantity INT NOT NULL DEFAULT 1,
        unit_price DECIMAL(10,2) NOT NULL DEFAULT 0,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
      ) ENGINE=InnoDB
    `);
  }

  console.info('Dashain campaign migration complete.');
  await sequelize.close();
}

main().catch(async (error) => {
  console.error(error.message);
  await sequelize.close().catch(() => {});
  process.exit(1);
});
