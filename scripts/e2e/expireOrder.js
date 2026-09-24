'use strict';

/**
 * E2E-only time travel for one fixture order, then the payment-timeout check
 * for that order, so browser tests need not wait:
 *   default            the stock hold and last payment activity lapse
 *   --age-proof=HOURS  only the payment proof gets older (its hold is left
 *                      alone): a proof awaiting review must never be cancelled
 *
 * NODE_ENV=e2e E2E_ALLOW_DB_MUTATION=true node scripts/e2e/expireOrder.js --order-id=123 [--age-proof=80]
 *
 * Refuses outside the guarded *_e2e database and for any order that is not an
 * E2E fixture order. Prints only the order id and the decision.
 */

const { loadE2eEnv } = require('./loadEnv');

async function main() {
  // The guard runs here, before models (and therefore any DB connection) load.
  loadE2eEnv({ mutation: true });
  const arg = process.argv.find((a) => a.startsWith('--order-id='));
  const orderId = Number(arg && arg.slice('--order-id='.length));
  if (!Number.isInteger(orderId) || orderId <= 0) throw new Error('--order-id=<positive integer> is required');

  const db = require('../../models');
  db.sequelize.options.logging = false;
  const { Op } = require('sequelize');
  const { ACCOUNTS } = require('./fixtureData');
  const fixtures = require('./fixtures');
  const { cancelIfStale } = require('../../services/orderExpiry.service');
  try {
    await fixtures.assertConnectedToE2e();
    const emails = Object.values(ACCOUNTS).filter((a) => a.type === 'customer').map((a) => a.email);
    const users = await db.User.findAll({ where: { email: { [Op.in]: emails } }, attributes: ['id'] });
    const scope = fixtures.buildOrderScope({ userIds: users.map((u) => u.id) });
    const order = await db.Order.findOne({ where: { [Op.and]: [{ id: orderId }, scope] } });
    if (!order) throw new Error(`Order ${orderId} is not an E2E fixture order`);

    const ageArg = process.argv.find((a) => a.startsWith('--age-proof='));
    const proofHours = ageArg ? Number(ageArg.slice('--age-proof='.length)) : null;
    if (ageArg && !(Number.isInteger(proofHours) && proofHours > 0)) throw new Error('--age-proof=<positive integer hours>');
    if (!ageArg) await db.InventoryReservation.update({ expires_at: new Date(Date.now() - 1000) }, { where: { order_id: orderId } });
    // Relative to the DB clock; Sequelize would otherwise overwrite updated_at.
    await db.sequelize.query('UPDATE order_payment_confirmations SET updated_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? HOUR) WHERE order_id = ?', { replacements: [proofHours || 100, orderId] });
    console.info(`E2E expire | order ${orderId} | ${await cancelIfStale(orderId)}`);
  } finally {
    await db.sequelize.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
