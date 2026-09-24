'use strict';

/**
 * Stale unpaid orders are cancelled once their inventory hold lapses.
 * DB-backed against caseverse_e2e. Time is controlled by back-dating
 * expires_at / updated_at, never by waiting.
 */

const { TIMEOUT_NOTE, cancelIfStale, cancelExpiredUnpaidOrders } = require('../../services/orderExpiry.service');
const { api, db, login, auth, SKU, inventoryOf, placeCustomerOrder, placeGuestOrder, PNG } = require('./helpers');

// Variants no other server suite reads: holds and deductions here cannot
// change what another suite sees as available.
const sku = SKU.pinkBow16;
const confirmedSku = SKU.pinkBow17;
const HOUR = 60 * 60 * 1000;
const open = [];

afterEach(async () => {
  // Release every hold this suite left open (cancel is refused once not pending).
  while (open.length) await api().post(`/api/guest-checkout/orders/${open.pop()}/cancel`);
});
afterAll(() => db.sequelize.close());

async function guestOrder(label, quantity = 1, forSku = sku) {
  const placed = await placeGuestOrder([{ sku: forSku, quantity }], { label });
  expect(placed.status).toBe(201);
  open.push(placed.body.guest_token);
  return { id: placed.body.data.id, token: placed.body.guest_token };
}

const confirmationFor = (orderId) => db.OrderPaymentConfirmation.findOne({ where: { order_id: orderId } });
const holdsFor = async (orderId) => (await db.InventoryReservation.findAll({ where: { order_id: orderId } })).map((r) => r.status);
const cancelledHistory = (orderId) => db.OrderStatusHistory.findAll({ where: { order_id: orderId, status: 'cancelled' } });

/** Makes the order's hold lapse and its last payment activity `paymentAgoMs` old. */
async function lapse(orderId, paymentAgoMs = 100 * HOUR) {
  await db.InventoryReservation.update({ expires_at: new Date(Date.now() - 1000) }, { where: { order_id: orderId } });
  // Sequelize always manages updated_at itself, so the test sets it directly.
  // (relative to the DB clock: raw replacements would format the Date in local time).
  await db.sequelize.query('UPDATE order_payment_confirmations SET updated_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? SECOND) WHERE order_id = ?', { replacements: [Math.round(paymentAgoMs / 1000), orderId] });
}

async function approve(orderId) {
  const confirmation = await confirmationFor(orderId);
  const res = await api().post(`/api/admin/payment-confirmations/${confirmation.id}/approve`).set(auth(await login('staff'))).send({});
  expect(res.status).toBe(200);
}

async function expectCancelledByTimeout(orderId) {
  const order = await db.Order.findByPk(orderId);
  expect(order.status).toBe('cancelled');
  expect(order.cancellation_reason).toBe('payment_timeout');
  const history = await cancelledHistory(orderId);
  expect(history).toHaveLength(1);
  expect(history[0]).toMatchObject({ note: TIMEOUT_NOTE, changed_by_staff_id: null });
  expect(await holdsFor(orderId)).toEqual(['released']);
}

async function expectKept(orderId, reason) {
  expect(await cancelIfStale(orderId)).toBe(reason);
  expect((await db.Order.findByPk(orderId)).status).not.toBe('cancelled');
  expect(await cancelledHistory(orderId)).toHaveLength(0);
}

describe('pending (unpaid) orders', () => {
  it('A / physical stock: a lapsed unpaid order is cancelled, physical untouched, availability restored', async () => {
    const before = await inventoryOf(sku);
    const { id } = await guestOrder('exp-pending', 2);
    expect(await inventoryOf(sku)).toEqual({ ...before, reserved: before.reserved + 2, available: before.available - 2 });
    await lapse(id, 2 * HOUR);
    expect(await inventoryOf(sku)).toEqual(before); // lapsed hold already stops counting
    expect(await cancelIfStale(id)).toBe('cancelled');
    await expectCancelledByTimeout(id);
    expect(await inventoryOf(sku)).toEqual(before);
  });

  it('a pending order inside its unpaid window is kept', async () => {
    const { id } = await guestOrder('exp-pending-live');
    await expectKept(id, 'hold_active');
  });
});

describe('advance proof', () => {
  it('B: proof uploaded, review hold still valid: kept', async () => {
    const { id, token } = await guestOrder('exp-proof-live');
    expect((await api().post(`/api/guest-checkout/orders/${token}/payment-proof`).attach('proof', PNG, { filename: 'p.png', contentType: 'image/png' })).status).toBe(200);
    await expectKept(id, 'hold_active');
    expect((await confirmationFor(id)).status).toBe('proof_uploaded');
  });

  it('C: proof uploaded, review hold expired without staff action: cancelled', async () => {
    const before = await inventoryOf(sku);
    const { id, token } = await guestOrder('exp-proof-lapsed');
    await api().post(`/api/guest-checkout/orders/${token}/payment-proof`).attach('proof', PNG, { filename: 'p.png', contentType: 'image/png' });
    await lapse(id, 73 * HOUR);
    expect(await cancelIfStale(id)).toBe('cancelled');
    await expectCancelledByTimeout(id);
    // The uploaded proof record is kept for the history.
    expect(await confirmationFor(id)).toMatchObject({ status: 'proof_uploaded' });
    expect(await inventoryOf(sku)).toEqual(before);
  });

  it('a proof uploaded after the hold lapsed still gets its review window', async () => {
    const { id, token } = await guestOrder('exp-proof-late');
    await lapse(id, 2 * HOUR);
    await api().post(`/api/guest-checkout/orders/${token}/payment-proof`).attach('proof', PNG, { filename: 'p.png', contentType: 'image/png' });
    await expectKept(id, 'recent_payment_activity');
  });

  it('F: rejected proof inside its retry window: kept', async () => {
    const { id, token } = await guestOrder('exp-rejected-live');
    await api().post(`/api/guest-checkout/orders/${token}/payment-proof`).attach('proof', PNG, { filename: 'p.png', contentType: 'image/png' });
    const reject = await api().post(`/api/admin/payment-confirmations/${(await confirmationFor(id)).id}/reject`).set(auth(await login('staff'))).send({ note: 'E2E unreadable' });
    expect(reject.status).toBe(200);
    await expectKept(id, 'hold_active');
  });

  it('G: rejected proof, retry window expired without a new upload: cancelled', async () => {
    const { id, token } = await guestOrder('exp-rejected-lapsed');
    await api().post(`/api/guest-checkout/orders/${token}/payment-proof`).attach('proof', PNG, { filename: 'p.png', contentType: 'image/png' });
    await api().post(`/api/admin/payment-confirmations/${(await confirmationFor(id)).id}/reject`).set(auth(await login('staff'))).send({ note: 'E2E unreadable' });
    await lapse(id, 2 * HOUR);
    expect(await cancelIfStale(id)).toBe('cancelled');
    await expectCancelledByTimeout(id);
  });
});

describe('cash on delivery', () => {
  it('D: COD requested, review hold still valid: kept', async () => {
    const { id, token } = await guestOrder('exp-cod-live');
    expect((await api().post(`/api/guest-checkout/orders/${token}/payment-method/cod`)).status).toBe(200);
    await expectKept(id, 'hold_active');
  });

  it('E: COD requested, hold expired without confirmation: cancelled', async () => {
    const { id, token } = await guestOrder('exp-cod-lapsed');
    await api().post(`/api/guest-checkout/orders/${token}/payment-method/cod`);
    await lapse(id, 73 * HOUR);
    expect(await cancelIfStale(id)).toBe('cancelled');
    await expectCancelledByTimeout(id);
  });
});

describe('never cancelled', () => {
  it('H/I/J: approved advance, confirmed COD and every fulfilment state are left alone', async () => {
    const staff = await login('staff');
    const advance = await guestOrder('exp-approved', 1, confirmedSku);
    await api().post(`/api/guest-checkout/orders/${advance.token}/payment-proof`).attach('proof', PNG, { filename: 'p.png', contentType: 'image/png' });
    await approve(advance.id);
    const cod = await guestOrder('exp-cod-confirmed', 1, confirmedSku);
    await api().post(`/api/guest-checkout/orders/${cod.token}/payment-method/cod`);
    await approve(cod.id);
    await api().put(`/api/admin/orders/${cod.id}/status`).set(auth(staff)).send({ status: 'shipped' });
    const delivered = await guestOrder('exp-delivered', 1, confirmedSku);
    await api().post(`/api/guest-checkout/orders/${delivered.token}/payment-method/cod`);
    await approve(delivered.id);
    await api().put(`/api/admin/orders/${delivered.id}/status`).set(auth(staff)).send({ status: 'delivered' });

    for (const [{ id }, status] of [[advance, 'processing'], [cod, 'shipped'], [delivered, 'delivered']]) {
      await lapse(id);
      expect(await cancelIfStale(id)).toBe('order_not_pending');
      expect((await db.Order.findByPk(id)).status).toBe(status);
      expect(await holdsFor(id)).toEqual(['committed']);
    }
    expect((await confirmationFor(advance.id)).status).toBe('approved');
    expect((await confirmationFor(cod.id)).status).toBe('cod_confirmed');
  });

  it('K: an already cancelled order is a no-op with no extra history', async () => {
    const { id, token } = await guestOrder('exp-already-cancelled');
    await api().post(`/api/guest-checkout/orders/${token}/cancel`);
    await lapse(id);
    expect(await cancelIfStale(id)).toBe('order_not_pending');
    const order = await db.Order.findByPk(id);
    expect(order.cancellation_reason).toBe('guest');
    expect(await cancelledHistory(id)).toHaveLength(1);
  });

  it('a legacy unpaid order without reservations is never auto-cancelled', async () => {
    const { id } = await guestOrder('exp-legacy');
    await db.InventoryReservation.destroy({ where: { order_id: id } });
    await lapse(id);
    await expectKept(id, 'legacy_no_reservations');
  });
});

describe('maintenance run', () => {
  it('dry run changes nothing; execute cancels each eligible order exactly once, even when run twice concurrently', async () => {
    const a = await guestOrder('exp-batch-a');
    const b = await guestOrder('exp-batch-b');
    const live = await guestOrder('exp-batch-live');
    await lapse(a.id);
    await lapse(b.id);

    const dry = await cancelExpiredUnpaidOrders();
    expect(dry.dry_run).toBe(true);
    expect(dry.cancelled).toBe(0);
    expect(dry.eligible).toBeGreaterThanOrEqual(2);
    expect((await db.Order.findByPk(a.id)).status).toBe('pending');

    const runs = await Promise.all([
      cancelExpiredUnpaidOrders({ execute: true, batchSize: 1 }),
      cancelExpiredUnpaidOrders({ execute: true, batchSize: 1 }),
    ]);
    for (const { id } of [a, b]) await expectCancelledByTimeout(id);
    expect(runs[0].cancelled + runs[1].cancelled).toBeGreaterThanOrEqual(2);
    expect((await db.Order.findByPk(live.id)).status).toBe('pending');

    const again = await cancelExpiredUnpaidOrders({ execute: true });
    expect(again.cancelled).toBe(0);
    for (const { id } of [a, b]) expect(await cancelledHistory(id)).toHaveLength(1);
  });

  it('the same order cancelled concurrently gets exactly one transition', async () => {
    const { id } = await guestOrder('exp-race');
    await lapse(id);
    const results = await Promise.all([cancelIfStale(id), cancelIfStale(id), cancelIfStale(id)]);
    expect(results.filter((r) => r === 'cancelled')).toHaveLength(1);
    expect(results.filter((r) => r === 'order_not_pending')).toHaveLength(2);
    await expectCancelledByTimeout(id);
  });
});

describe('what customers and staff see', () => {
  it('customer, guest and admin order responses carry the timeout reason; other cancellations are distinguished', async () => {
    const customer = await login('customerA');
    const placed = await placeCustomerOrder('customerA', [{ sku, quantity: 1 }]);
    expect(placed.status).toBe(201);
    await lapse(placed.body.data.id);
    expect(await cancelIfStale(placed.body.data.id)).toBe('cancelled');
    const mine = await api().get(`/api/orders/${placed.body.data.id}`).set(auth(customer));
    expect(mine.body.data).toMatchObject({ status: 'cancelled', cancellation_reason: 'payment_timeout' });
    expect(mine.body.data).not.toHaveProperty('reservations');

    const guest = await guestOrder('exp-guest-view');
    await lapse(guest.id);
    await cancelIfStale(guest.id);
    const guestView = await api().get(`/api/guest-checkout/orders/${guest.token}`);
    expect(guestView.body.data).toMatchObject({ status: 'cancelled', cancellation_reason: 'payment_timeout' });

    const staffCancelled = await guestOrder('exp-staff-cancel');
    const staff = await login('staff');
    await api().put(`/api/admin/orders/${staffCancelled.id}/status`).set(auth(staff)).send({ status: 'cancelled', cancellationReason: 'payment_timeout' });
    const adminView = await api().get(`/api/admin/orders/${staffCancelled.id}`).set(auth(staff));
    // Staff cannot forge the system reason through the API.
    expect(adminView.body.data.cancellation_reason).toBe('staff');

    const self = await placeCustomerOrder('customerA', [{ sku, quantity: 1 }]);
    await api().post(`/api/orders/${self.body.data.id}/cancel`).set(auth(customer));
    expect((await db.Order.findByPk(self.body.data.id)).cancellation_reason).toBe('customer');
  });
});
