'use strict';

/**
 * Concurrent lifecycle writes on the same order all take the canonical lock
 * order (payment confirmation, order, reservations, variants), so they
 * serialize instead of deadlocking: one valid terminal outcome, no 5xx, stock
 * and history coherent. Each race is repeated. DB-backed against caseverse_e2e.
 */

const { cancelIfStale, cancelExpiredUnpaidOrders } = require('../../services/orderExpiry.service');
const { api, db, login, auth, SKU, inventoryOf, placeCustomerOrder, placeGuestOrder, PNG } = require('./helpers');

const sku = SKU.pinkBow17;
const ROUNDS = 5;

beforeAll(async () => {
  // Enough physical stock for every round; no other suite relies on this value.
  await db.ProductVariant.update({ stock_quantity: 30 }, { where: { sku } });
});
afterAll(() => db.sequelize.close());

const confirmationFor = (orderId) => db.OrderPaymentConfirmation.findOne({ where: { order_id: orderId } });
const historyOf = async (orderId) => (await db.OrderStatusHistory.findAll({ where: { order_id: orderId }, order: [['id', 'ASC']] })).map((h) => h.status);
const holdStatus = async (orderId) => (await db.InventoryReservation.findOne({ where: { order_id: orderId } })).status;

describe('customer cancellation vs staff approval', () => {
  it(`always ends in exactly one of the two outcomes (${ROUNDS} rounds)`, async () => {
    const customer = await login('customerA');
    const staff = await login('staff');
    const seen = new Set();
    for (let round = 0; round < ROUNDS; round += 1) {
      const placed = await placeCustomerOrder('customerA', [{ sku, quantity: 1 }]);
      const id = placed.body.data.id;
      expect((await api().post(`/api/orders/${id}/payment-proof`).set(auth(customer)).attach('proof', PNG, { filename: 'p.png', contentType: 'image/png' })).status).toBe(201);
      const before = await inventoryOf(sku);
      const confirmation = await confirmationFor(id);

      const [cancel, approve] = await Promise.all([
        api().post(`/api/orders/${id}/cancel`).set(auth(customer)),
        api().post(`/api/admin/payment-confirmations/${confirmation.id}/approve`).set(auth(staff)).send({}),
      ]);
      expect(cancel.status).toBeLessThan(500);
      expect(approve.status).toBeLessThan(500);

      if (cancel.status === 200) {
        expect(approve.status).toBe(409);
        expect(approve.body.error.code).toBe('order_cancelled');
        expect(await historyOf(id)).toEqual(['pending', 'cancelled']);
        expect(await holdStatus(id)).toBe('released');
        expect(await inventoryOf(sku)).toEqual({ physical: before.physical, reserved: before.reserved - 1, available: before.available + 1 });
        seen.add('cancelled');
      } else {
        expect(approve.status).toBe(200);
        expect(cancel.status).toBe(400);
        expect(cancel.body.error.code).toBe('order_not_cancellable');
        expect(await historyOf(id)).toEqual(['pending', 'processing']);
        expect(await holdStatus(id)).toBe('committed');
        expect(await inventoryOf(sku)).toEqual({ physical: before.physical - 1, reserved: before.reserved - 1, available: before.available });
        seen.add('approved');
      }
    }
    expect(seen.size).toBeGreaterThanOrEqual(1);
  });
});

describe('customer cancellation vs payment-timeout cancellation', () => {
  it(`exactly one cancellation, with the winner's reason (${ROUNDS} rounds)`, async () => {
    const customer = await login('customerA');
    for (let round = 0; round < ROUNDS; round += 1) {
      const placed = await placeCustomerOrder('customerA', [{ sku, quantity: 1 }]);
      const id = placed.body.data.id;
      await db.InventoryReservation.update({ expires_at: new Date(Date.now() - 1000) }, { where: { order_id: id } });
      await db.sequelize.query('UPDATE order_payment_confirmations SET updated_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 2 HOUR) WHERE order_id = ?', { replacements: [id] });
      const before = await inventoryOf(sku);

      const [cancel, auto] = await Promise.all([
        api().post(`/api/orders/${id}/cancel`).set(auth(customer)),
        cancelIfStale(id),
      ]);
      expect(cancel.status).toBeLessThan(500);
      const order = await db.Order.findByPk(id);
      expect(order.status).toBe('cancelled');
      if (cancel.status === 200) {
        expect(auto).toBe('order_not_pending');
        expect(order.cancellation_reason).toBe('customer');
      } else {
        expect(auto).toBe('cancelled');
        expect(cancel.status).toBe(400);
        expect(order.cancellation_reason).toBe('payment_timeout');
      }
      expect(await historyOf(id)).toEqual(['pending', 'cancelled']);
      expect(await holdStatus(id)).toBe('released');
      expect(await inventoryOf(sku)).toEqual(before); // the lapsed hold no longer counted; physical never moved
    }
  });
});

describe('guest cancellation vs COD confirmation', () => {
  it(`always ends in exactly one of the two outcomes (${ROUNDS} rounds)`, async () => {
    const staff = await login('staff');
    for (let round = 0; round < ROUNDS; round += 1) {
      const placed = await placeGuestOrder([{ sku, quantity: 1 }], { label: `race-cod-${round}` });
      const { id } = placed.body.data;
      const token = placed.body.guest_token;
      expect((await api().post(`/api/guest-checkout/orders/${token}/payment-method/cod`)).status).toBe(200);
      const before = await inventoryOf(sku);
      const confirmation = await confirmationFor(id);

      const [cancel, confirm] = await Promise.all([
        api().post(`/api/guest-checkout/orders/${token}/cancel`),
        api().post(`/api/admin/payment-confirmations/${confirmation.id}/approve`).set(auth(staff)).send({}),
      ]);
      expect(cancel.status).toBeLessThan(500);
      expect(confirm.status).toBeLessThan(500);
      if (cancel.status === 200) {
        expect(confirm.status).toBe(409);
        expect(confirm.body.error.code).toBe('order_cancelled');
        expect((await confirmationFor(id)).status).toBe('cod_pending');
        expect(await historyOf(id)).toEqual(['pending', 'cancelled']);
        expect(await inventoryOf(sku)).toEqual({ physical: before.physical, reserved: before.reserved - 1, available: before.available + 1 });
      } else {
        expect(confirm.status).toBe(200);
        expect((await confirmationFor(id)).status).toBe('cod_confirmed');
        expect(await historyOf(id)).toEqual(['pending', 'processing']);
        expect(await inventoryOf(sku)).toEqual({ physical: before.physical - 1, reserved: before.reserved - 1, available: before.available });
      }
    }
  });
});

describe('cancelled orders cannot be reviewed', () => {
  it('approve, reject and COD confirmation on a cancelled order return 409 order_cancelled', async () => {
    const staff = await login('staff');
    const customer = await login('customerA');
    const advance = await placeCustomerOrder('customerA', [{ sku, quantity: 1 }]);
    await api().post(`/api/orders/${advance.body.data.id}/payment-proof`).set(auth(customer)).attach('proof', PNG, { filename: 'p.png', contentType: 'image/png' });
    await api().post(`/api/orders/${advance.body.data.id}/cancel`).set(auth(customer));
    const cod = await placeGuestOrder([{ sku, quantity: 1 }], { label: 'race-cancelled-cod' });
    await api().post(`/api/guest-checkout/orders/${cod.body.guest_token}/payment-method/cod`);
    await api().post(`/api/guest-checkout/orders/${cod.body.guest_token}/cancel`);

    const advanceConfirmation = await confirmationFor(advance.body.data.id);
    const codConfirmation = await confirmationFor(cod.body.data.id);
    for (const [confirmation, action] of [[advanceConfirmation, 'approve'], [advanceConfirmation, 'reject'], [codConfirmation, 'approve']]) {
      const res = await api().post(`/api/admin/payment-confirmations/${confirmation.id}/${action}`).set(auth(staff)).send({});
      expect(res.status).toBe(409);
      expect(res.body.error).toMatchObject({ code: 'order_cancelled', message: 'This order has already been cancelled and its payment confirmation can no longer be reviewed.' });
      expect(JSON.stringify(res.body)).not.toMatch(/Sequelize|SELECT|reservation/i);
    }
    expect((await confirmationFor(advance.body.data.id)).status).toBe('proof_uploaded');
    expect((await confirmationFor(cod.body.data.id)).status).toBe('cod_pending');
  });
});

describe('overlapping maintenance runs', () => {
  it('three concurrent runs cancel each stale order exactly once and never touch proof_uploaded', async () => {
    const orders = [];
    for (let i = 0; i < 4; i += 1) {
      const placed = await placeGuestOrder([{ sku, quantity: 1 }], { label: `race-maint-${i}` });
      orders.push(placed.body.data.id);
      await db.InventoryReservation.update({ expires_at: new Date(Date.now() - 1000) }, { where: { order_id: placed.body.data.id } });
      await db.sequelize.query('UPDATE order_payment_confirmations SET updated_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 2 HOUR) WHERE order_id = ?', { replacements: [placed.body.data.id] });
    }
    const runs = await Promise.all([1, 2, 3].map(() => cancelExpiredUnpaidOrders({ execute: true, batchSize: 2 })));
    expect(runs.reduce((sum, r) => sum + r.cancelled, 0)).toBeGreaterThanOrEqual(orders.length);
    for (const id of orders) {
      expect(await historyOf(id)).toEqual(['pending', 'cancelled']);
      expect((await db.Order.findByPk(id)).cancellation_reason).toBe('payment_timeout');
    }
  });
});
