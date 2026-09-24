'use strict';

/**
 * Cancelling an order that never reached payment confirmation gives back its
 * coupon use and redeemed loyalty points, exactly once, whoever cancels it.
 * A paid order cancelled later keeps both. DB-backed against caseverse_e2e.
 */

const { cancelIfStale } = require('../../services/orderExpiry.service');
const loyalty = require('../../services/loyalty.service');
const { api, db, login, auth, SKU, placeCustomerOrder } = require('./helpers');

const sku = SKU.pinkBow13ProMax;
const CODE = 'E2E-CANCEL-10';
const POINTS = 50;
let coupon;
let customer;

beforeAll(async () => {
  // A fixed E2E-only coupon: one use per customer, so reuse proves a release.
  [coupon] = await db.Coupon.findOrCreate({
    where: { code: CODE },
    defaults: { code: CODE, description: 'E2E cancellation test', discount_type: 'fixed', discount_value: 10, min_order_amount: 0, usage_limit_total: null, usage_limit_per_user: 1, is_active: true },
  });
  customer = await login('customerA');
  // Fixture points (E2E cleanup removes every ledger row of fixture customers).
  await db.LoyaltyTransaction.create({ user_id: customer.profile.id, order_id: null, points: 500, type: 'adjustment', note: 'E2E seed points' });
  await loyalty.recalcBalance(customer.profile.id);
});
afterAll(() => db.sequelize.close());

const balance = async () => (await db.User.findByPk(customer.profile.id)).loyalty_points;
const countedUses = () => db.CouponUsage.count({ where: { coupon_id: coupon.id, user_id: customer.profile.id, released_at: null } });
const restoreRows = (orderId) => db.LoyaltyTransaction.count({ where: { order_id: orderId, type: 'adjustment' } });

async function orderWithBenefits() {
  const before = await balance();
  const placed = await placeCustomerOrder('customerA', [{ sku, quantity: 1 }], { extra: { coupon_code: CODE, redeem_points: POINTS } });
  expect(placed.status).toBe(201);
  expect(placed.body.data.coupon_id).toBe(coupon.id);
  expect(await countedUses()).toBe(1);
  expect(await balance()).toBe(before - POINTS);
  return { id: placed.body.data.id, before };
}

async function expectRestoredOnce(id, before) {
  expect(await countedUses()).toBe(0);
  expect(await db.CouponUsage.count({ where: { order_id: id } })).toBe(1); // history kept
  expect(await balance()).toBe(before);
  expect(await restoreRows(id)).toBe(1);
  expect(await db.OrderStatusHistory.count({ where: { order_id: id, status: 'cancelled' } })).toBe(1);
}

describe('unpaid cancellation gives back checkout benefits', () => {
  it('customer cancellation restores coupon use and points once; a second cancel changes nothing', async () => {
    const { id, before } = await orderWithBenefits();
    expect((await api().post(`/api/orders/${id}/cancel`).set(auth(customer))).status).toBe(200);
    await expectRestoredOnce(id, before);
    const again = await api().post(`/api/orders/${id}/cancel`).set(auth(customer));
    expect(again.status).toBe(400);
    await expectRestoredOnce(id, before);
  });

  it('payment-timeout cancellation restores the same way (and the coupon is usable again)', async () => {
    const { id, before } = await orderWithBenefits();
    await db.InventoryReservation.update({ expires_at: new Date(Date.now() - 1000) }, { where: { order_id: id } });
    await db.sequelize.query('UPDATE order_payment_confirmations SET updated_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 2 HOUR) WHERE order_id = ?', { replacements: [id] });
    expect(await cancelIfStale(id)).toBe('cancelled');
    await expectRestoredOnce(id, before);
    expect(await cancelIfStale(id)).toBe('order_not_pending');
    await expectRestoredOnce(id, before);
  });

  it('staff cancellation of an unpaid order restores the same way; repeating it is a no-op', async () => {
    const { id, before } = await orderWithBenefits();
    const staff = await login('staff');
    for (let i = 0; i < 2; i += 1) {
      expect((await api().put(`/api/admin/orders/${id}/status`).set(auth(staff)).send({ status: 'cancelled' })).status).toBe(200);
    }
    await expectRestoredOnce(id, before);
    // Service-level repeat inside a fresh transaction: still once.
    await db.sequelize.transaction((t) => loyalty.restoreRedeemedForOrder(db.Order.build({ id, user_id: customer.profile.id, order_number: 'x' }, { isNewRecord: false }), t));
    expect(await restoreRows(id)).toBe(1);
    expect(await balance()).toBe(before);
  });

  it('a paid order cancelled later keeps its coupon use and redeemed points', async () => {
    const { id, before } = await orderWithBenefits();
    expect((await api().post(`/api/orders/${id}/payment-method/cod`).set(auth(customer))).status).toBe(200);
    const confirmation = await db.OrderPaymentConfirmation.findOne({ where: { order_id: id } });
    const staff = await login('staff');
    expect((await api().post(`/api/admin/payment-confirmations/${confirmation.id}/approve`).set(auth(staff)).send({})).status).toBe(200);
    expect((await api().put(`/api/admin/orders/${id}/status`).set(auth(staff)).send({ status: 'cancelled' })).status).toBe(200);
    expect(await countedUses()).toBe(1);
    expect(await balance()).toBe(before - POINTS);
    expect(await restoreRows(id)).toBe(0);
  });
});
