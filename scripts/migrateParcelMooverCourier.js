'use strict';

// Additive/idempotent order snapshots. Existing orders deliberately remain
// untouched: carrier rates are never recalculated for historical purchases.
const { sequelize } = require('../config/database');

async function addColumnIfMissing(column, ddl) {
  const [rows] = await sequelize.query(`SHOW COLUMNS FROM orders LIKE '${column}'`);
  if (!rows.length) await sequelize.query(ddl);
}

async function main() {
  await sequelize.authenticate();
  const columns = [
    ['courier_provider', 'ALTER TABLE orders ADD COLUMN courier_provider VARCHAR(50) NULL AFTER shipping_amount'],
    ['courier_destination_id', 'ALTER TABLE orders ADD COLUMN courier_destination_id VARCHAR(100) NULL AFTER courier_provider'],
    ['courier_destination_name', 'ALTER TABLE orders ADD COLUMN courier_destination_name VARCHAR(200) NULL AFTER courier_destination_id'],
    ['courier_service_type', 'ALTER TABLE orders ADD COLUMN courier_service_type VARCHAR(50) NULL AFTER courier_destination_name'],
    ['courier_weight_kg', 'ALTER TABLE orders ADD COLUMN courier_weight_kg DECIMAL(10,3) NULL AFTER courier_service_type'],
    ['courier_base_charge', 'ALTER TABLE orders ADD COLUMN courier_base_charge DECIMAL(10,2) NULL AFTER courier_weight_kg'],
    ['courier_weight_surcharge', 'ALTER TABLE orders ADD COLUMN courier_weight_surcharge DECIMAL(10,2) NULL AFTER courier_base_charge'],
    ['courier_delivery_charge', 'ALTER TABLE orders ADD COLUMN courier_delivery_charge DECIMAL(10,2) NULL AFTER courier_weight_surcharge'],
    ['courier_rate_basis', 'ALTER TABLE orders ADD COLUMN courier_rate_basis VARCHAR(255) NULL AFTER courier_delivery_charge'],
    ['courier_valley', 'ALTER TABLE orders ADD COLUMN courier_valley VARCHAR(50) NULL AFTER courier_rate_basis'],
  ];
  for (const [column, ddl] of columns) await addColumnIfMissing(column, ddl);
  console.info('ParcelMoover courier migration complete.');
  await sequelize.close();
}

main().catch(async (error) => {
  console.error(error.message);
  await sequelize.close().catch(() => {});
  process.exit(1);
});
