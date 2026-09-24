'use strict';

/**
 * An uploaded payment proof waits on STAFF: its order is never cancelled for
 * time and its stock stays held however long review takes. The 72 h review
 * SLA is display-only. DB-backed against caseverse_e2e; time is moved by
 * back-dating rows, never by waiting.
 */

const { cancelIfStale, cancelExpiredUnpaidOrders } = require('../../services/orderExpiry.service');
const { api, db, login, auth, SKU, inventoryOf, placeCustomerOrder, placeGuestOrder, PNG } = require('./helpers');

const sku = SKU.pinkBow16;
const HOUR = 60 * 60 * 1000;
const open = [];

afterEach(async () => {
  while (open.length) await api().post(`/api/guest-checkout/orders/${open.pop()}/cancel`);
});
afterAll(() => db.sequelize.close());

async function guestOrder(label) {
  const placed = await placeGuestOrder([{ sku, quantity: 1 }], { label });
  expect(placed.status).toBe(201);
  open.push(placed.body.guest_token);
  return { id: placed.body.data.id, token: placed.body.guest_token };
}

async function uploadProof(token) {
  const res = await api().post(`/api/guest-checkout/orders/${token}/payment-proof`).attach('proof', PNG, { filename: 'p.png', contentType: 'image/png' });
  expect(res.status).toBe(200);
}

const confirmationFor = (orderId) => db.OrderPaymentConfirmation.findOne({ where: { order_id: orderId } });
const holdOf = (orderId) => db.InventoryReservation.findOne({ where: { order_id: orderId } });

/** Makes the proof (the confirmation's last change) `hours` old, relative to the DB clock. */
async function ageProof(orderId, hours) {
  await db.sequelize.query('UPDATE order_payment_confirmations SET updated_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? HOUR) WHERE order_id = ?', { replacements: [hours, orderId] });
}

async function review(orderId, action) {
  const confirmation = await confirmationFor(orderId);
  return api().post(`/api/admin/payment-confirmations/${confirmation.id}/${action}`).set(auth(await login('staff'))).send(action === 'reject' ? { note: 'E2E unreadable' } : {});
}

async function expectStillWaitingOnStaff(orderId) {
  expect(await cancelIfStale(orderId)).toBe('awaiting_staff_review');
  expect((await db.Order.findByPk(orderId)).status).toBe('pending');
  expect((await confirmationFor(orderId)).status).toBe('proof_uploaded');
  expect(await holdOf(orderId)).toMatchObject({ status: 'active', expires_at: null });
}

describe('proof awaiting staff review', () => {
  it('B: right after upload the hold has no deadline and the order is kept', async () => {
    const { id, token } = await guestOrder('proof-fresh');
    await uploadProof(token);
    await expectStillWaitingOnStaff(id);
  });

  it('D/E/F: after 72 h and after 7 days the order is not cancelled and its stock is still held', async () => {
    const before = await inventoryOf(sku);
    const { id, token } = await guestOrder('proof-overdue');
    await uploadProof(token);
    const held = { physical: before.physical, reserved: before.reserved + 1, available: before.available - 1 };

    await ageProof(id, 73);
    await expectStillWaitingOnStaff(id);
    expect(await inventoryOf(sku)).toEqual(held);

    await ageProof(id, 8 * 24);
    await expectStillWaitingOnStaff(id);
    const run = await cancelExpiredUnpaidOrders({ execute: true });
    expect(run.cancelled).toBe(0);
    expect((await db.Order.findByPk(id)).status).toBe('pending');
    expect(await inventoryOf(sku)).toEqual(held);
  });

  it('SLA is display-only: the queue and order detail flag an overdue review, the customer view does not', async () => {
    const { id, token } = await guestOrder('proof-sla');
    await uploadProof(token);
    const staff = await login('staff');
    const queueRow = async () => (await api().get('/api/admin/payment-confirmations').set(auth(staff))).body.data.find((row) => row.order_id === id);
    expect((await queueRow()).review_overdue).toBe(false);
    await ageProof(id, 73);
    expect((await queueRow()).review_overdue).toBe(true);
    const detail = await api().get(`/api/admin/orders/${id}`).set(auth(staff));
    expect(detail.body.data.paymentConfirmation.review_overdue).toBe(true);
    const guestView = await api().get(`/api/guest-checkout/orders/${token}`);
    expect(guestView.body.data.status).toBe('pending');
    expect(guestView.body.data.paymentConfirmation).not.toHaveProperty('review_overdue');
    expect((await confirmationFor(id)).status).toBe('proof_uploaded');
  });

  it('G: approval after 72 h succeeds and commits the stock exactly once', async () => {
    const before = await inventoryOf(sku);
    const { id, token } = await guestOrder('proof-late-approve');
    await uploadProof(token);
    await ageProof(id, 80);
    expect((await review(id, 'approve')).status).toBe(200);
    expect(await holdOf(id)).toMatchObject({ status: 'committed' });
    expect(await inventoryOf(sku)).toEqual({ physical: before.physical - 1, reserved: before.reserved, available: before.available - 1 });
    expect((await review(id, 'approve')).status).toBe(400);
    expect((await inventoryOf(sku)).physical).toBe(before.physical - 1);
    expect((await db.Order.findByPk(id)).status).toBe('processing');
  });

  it('H/J: rejection after 72 h starts a 60 min retry hold; a new upload removes the deadline again', async () => {
    const { id, token } = await guestOrder('proof-late-reject');
    await uploadProof(token);
    await ageProof(id, 80);
    expect((await review(id, 'reject')).status).toBe(200);
    const retry = await holdOf(id);
    expect(retry.status).toBe('active');
    const left = retry.expires_at.getTime() - Date.now();
    expect(left).toBeGreaterThan(55 * 60 * 1000);
    expect(left).toBeLessThanOrEqual(60 * 60 * 1000);
    expect(await cancelIfStale(id)).toBe('hold_active');

    await uploadProof(token);
    await expectStillWaitingOnStaff(id);
  });

  it('I: a rejected proof whose retry hold expires without a new upload is cancelled', async () => {
    const before = await inventoryOf(sku);
    const { id, token } = await guestOrder('proof-retry-lapsed');
    await uploadProof(token);
    expect((await review(id, 'reject')).status).toBe(200);
    await db.InventoryReservation.update({ expires_at: new Date(Date.now() - 1000) }, { where: { order_id: id } });
    await db.sequelize.query('UPDATE order_payment_confirmations SET updated_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 2 HOUR) WHERE order_id = ?', { replacements: [id] });
    expect(await cancelIfStale(id)).toBe('cancelled');
    expect(await db.Order.findByPk(id)).toMatchObject({ status: 'cancelled', cancellation_reason: 'payment_timeout' });
    expect(await inventoryOf(sku)).toEqual(before);
  });

  it('a proof uploaded after the unpaid hold lapsed revives the hold when the stock is still there', async () => {
    // Signed-in customer route (its own upload limiter).
    const customer = await login('customerA');
    const placed = await placeCustomerOrder('customerA', [{ sku, quantity: 1 }]);
    expect(placed.status).toBe(201);
    const id = placed.body.data.id;
    await db.InventoryReservation.update({ expires_at: new Date(Date.now() - 1000) }, { where: { order_id: id } });
    const res = await api().post(`/api/orders/${id}/payment-proof`).set(auth(customer)).attach('proof', PNG, { filename: 'p.png', contentType: 'image/png' });
    expect(res.status).toBe(201);
    await expectStillWaitingOnStaff(id);
    expect((await api().post(`/api/orders/${id}/cancel`).set(auth(customer))).status).toBe(200);
  });

  it('a proof uploaded after the hold lapsed and the stock sold keeps the order for staff; approval refuses', async () => {
    const { id, token } = await guestOrder('proof-after-sellout');
    await db.InventoryReservation.update({ expires_at: new Date(Date.now() - 1000) }, { where: { order_id: id } });
    const { available } = await inventoryOf(sku);
    const taker = await guestOrder('proof-sellout-taker');
    if (available > 1) {
      const rest = await placeGuestOrder([{ sku, quantity: available - 1 }], { label: 'proof-sellout-rest' });
      expect(rest.status).toBe(201);
      open.push(rest.body.guest_token);
    }
    expect((await inventoryOf(sku)).available).toBe(0);
    await uploadProof(token);
    expect(await cancelIfStale(id)).toBe('awaiting_staff_review');
    expect((await db.Order.findByPk(id)).status).toBe('pending');
    const refused = await review(id, 'approve');
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('reservation_lapsed_insufficient_stock');
    expect(taker.id).toBeGreaterThan(id);
  });
});
