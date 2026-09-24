'use strict';

/**
 * Retention maintenance for inventory_reservations.
 *
 *   npm run inventory:prune-reservations                 dry run: counts only
 *   npm run inventory:prune-reservations -- --execute    deletes eligible rows
 *   optional: --batch-size=500
 *
 * Eligible: released / expired rows older than INVENTORY_RESERVATION_RETENTION_DAYS
 * (default 90) and restocked rows older than INVENTORY_RESTOCKED_RETENTION_DAYS
 * (default 180), measured from their last status change, and only for
 * cancelled orders. Active and committed rows are never deleted. Deletes run in
 * bounded batches. Prints counts only, never order or customer data.
 */
const db = require('../models');
const inventory = require('../services/inventory.service');

function parseArgs(argv) {
  const execute = argv.includes('--execute');
  const sizeArg = argv.find((arg) => arg.startsWith('--batch-size='));
  const batchSize = sizeArg ? Number(sizeArg.split('=')[1]) : undefined;
  if (sizeArg && !(Number.isInteger(batchSize) && batchSize > 0)) {
    throw new Error('--batch-size must be a positive integer');
  }
  const unknown = argv.filter((arg) => arg !== '--execute' && !arg.startsWith('--batch-size='));
  if (unknown.length) throw new Error(`Unknown argument(s): ${unknown.join(' ')}`);
  return { execute, batchSize };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  db.sequelize.options.logging = false;
  await db.sequelize.authenticate();
  console.info(`Database: ${db.sequelize.config.database}`);
  const result = await inventory.pruneTerminalReservations(options);
  const policy = result.retention_days;
  console.info(`Retention (days): released ${policy.released}, expired ${policy.expired}, restocked ${policy.restocked}; committed and active rows are kept.`);
  console.info(`Eligible rows: ${result.eligible}`);
  if (result.dry_run) {
    console.info('Dry run: nothing deleted. Re-run with --execute to delete the eligible rows.');
  } else {
    console.info(`Deleted rows: ${result.deleted} in ${result.batches} batch(es).`);
  }
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => db.sequelize.close().catch(() => {}));
