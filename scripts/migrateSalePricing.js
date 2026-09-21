'use strict';

/** Add a compare-at price without touching order snapshots or historical totals. */
const { sequelize } = require('../config/database');

async function main() {
  await sequelize.authenticate();
  const [columns] = await sequelize.query("SHOW COLUMNS FROM product_variants LIKE 'compare_at_price'");
  if (!columns.length) {
    await sequelize.query('ALTER TABLE product_variants ADD COLUMN compare_at_price DECIMAL(10,2) NULL AFTER price');
  }
  // This is deliberately limited to active iPhone-cover variants currently at
  // the catalogue sale price. Historical order_items are never updated.
  const [result] = await sequelize.query(`
    UPDATE product_variants pv
    JOIN products p ON p.id = pv.product_id
    JOIN categories c ON c.id = p.category_id
    SET pv.compare_at_price = 999
    WHERE p.status = 'active' AND pv.is_active = 1
      AND c.slug = 'iphone-covers' AND pv.price = 699
      AND (pv.compare_at_price IS NULL OR pv.compare_at_price <> 999)
  `);
  console.info(`Sale pricing migration complete; ${result.affectedRows || 0} active cover variant(s) updated.`);
  await sequelize.close();
}

main().catch(async (error) => {
  console.error(error.message);
  await sequelize.close().catch(() => {});
  process.exit(1);
});
