'use strict';

/**
 * Cancels unpaid orders whose inventory hold has expired.
 *
 *   npm run orders:cancel-expired                 dry run: counts only
 *   npm run orders:cancel-expired -- --execute    cancels the eligible orders
 *   optional: --batch-size=100 (max 500)
 *
 * Recommended production cadence: every 15 minutes. Overlapping runs are safe:
 * each order is re-checked and cancelled under row locks exactly once.
 *
 * Eligible: order pending and waiting on the customer (payment pending,
 * rejected or cod_pending), every reservation lapsed, and no payment activity
 * inside its own window. A proof_uploaded order waits on staff and is never
 * cancelled for time. Each order is re-checked under row locks and
 * cancelled once with reason payment_timeout; physical stock is not changed.
 * Legacy orders without reservations are never touched. Prints aggregate
 * counts only, never order or customer data.
 */
const db = require('../models');
const { cancelExpiredUnpaidOrders } = require('../services/orderExpiry.service');

function parseArgs(argv) {
  const execute = argv.includes('--execute');
  const sizeArg = argv.find((arg) => arg.startsWith('--batch-size='));
  const batchSize = sizeArg ? Number(sizeArg.split('=')[1]) : undefined;
  if (sizeArg && !(Number.isInteger(batchSize) && batchSize > 0 && batchSize <= 500)) {
    throw new Error('--batch-size must be an integer from 1 to 500');
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
  const result = await cancelExpiredUnpaidOrders(options);
  console.info(`Pending orders with a lapsed hold: ${result.candidates}`);
  console.info(`Eligible for payment-timeout cancellation: ${result.eligible}`);
  const kept = Object.entries(result.kept);
  console.info(`Kept: ${kept.length ? kept.map(([reason, n]) => `${reason} ${n}`).join(', ') : 'none'}`);
  if (result.dry_run) {
    console.info('Dry run: nothing changed. Re-run with --execute to cancel the eligible orders.');
  } else {
    console.info(`Cancelled: ${result.cancelled} in ${result.batches} batch(es).`);
  }
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => db.sequelize.close().catch(() => {}));
