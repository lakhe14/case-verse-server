'use strict';

/**
 * Every schema migration, in the order a database needs them after
 * db/schema.sql. Each script is additive and idempotent, so the whole list
 * can be re-run on every deploy. Shared by `npm run db:migrate` and the
 * isolated E2E setup, so both build the same schema.
 */

const path = require('path');
const { spawnSync } = require('child_process');

const MIGRATIONS = [
  'migratePaymentConfirmations.js',
  'migrateSalePricing.js',
  'migrateGuestCheckout.js',
  'migrateDashainCampaign.js',
  'migrateParcelMooverCourier.js',
  'migrateGuestOrderIdempotency.js',
  'migrateInventoryReservations.js',
  'migrateOrderCancellationReason.js',
  'migrateReviewHolds.js',
  'migrateCouponUsageRelease.js',
  'migrateCouponUsageIndexes.js',
];

/** Runs each migration in its own process with the caller's environment. */
function runMigrations({ quiet = false } = {}) {
  for (const script of MIGRATIONS) {
    const result = spawnSync(process.execPath, [path.join(__dirname, script)], {
      env: process.env,
      stdio: ['ignore', quiet ? 'ignore' : 'inherit', 'inherit'],
    });
    if (result.status !== 0) throw new Error(`Migration ${script} failed`);
  }
  return MIGRATIONS.length;
}

module.exports = { MIGRATIONS, runMigrations };
