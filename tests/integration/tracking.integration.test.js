'use strict';

/**
 * Public order tracking (POST /api/order-tracking) and the customer-safe
 * order views. DB-backed against caseverse_e2e.
 *
 * The limiter state is per test file (fresh app), and every failed lookup in
 * this file counts toward the per-IP failure cap, so the rate-limit cases run
 * last and count from what earlier cases used.
 */

const crypto = require('crypto');
const { cancelIfStale } = require('../../services/orderExpiry.service');
const { normalizeNepalPhone } = require('../../services/orderView.service');
const { api, db, login, auth, SKU, placeGuestOrder, placeCustomerOrder, PNG } = require('./helpers');

afterAll(() => db.sequelize.close());

const GUEST_PHONE = '9800000009'; // helpers.guestDetails
const track = (order_number, phone) => api().post('/api/order-tracking').send({ order_number, phone });
const staff = () => login('staff');
const confirmationFor = (orderId) => db.OrderPaymentConfirmation.findOne({ where: { order_id: orderId } });

async function guestOrder(label) {
  const placed = await placeGuestOrder([{ sku: SKU.tracking, quantity: 1 }], { label: `track-${label}` });
  expect(placed.status).toBe(201);
  return { id: placed.body.data.id, number: placed.body.data.order_number, token: placed.body.guest_token, total: Number(placed.body.data.total_amount) };
}

const uploadProof = (token) => api().post(`/api/guest-checkout/orders/${token}/payment-proof`).attach('proof', PNG, { filename: 'p.png', contentType: 'image/png' });

async function review(orderId, action, note) {
  const res = await api().post(`/api/admin/payment-confirmations/${(await confirmationFor(orderId)).id}/${action}`).set(auth(await staff())).send(note ? { note } : {});
  expect(res.status).toBe(200);
}

async function setStatus(orderId, status, note) {
  const res = await api().put(`/api/admin/orders/${orderId}/status`).set(auth(await staff())).send({ status, note });
  expect(res.status).toBe(200);
}

/** Every key anywhere in a JSON value. */
function keysOf(value, found = new Set()) {
  if (Array.isArray(value)) value.forEach((v) => keysOf(v, found));
  else if (value && typeof value === 'object') Object.entries(value).forEach(([k, v]) => { found.add(k); keysOf(v, found); });
  return found;
}

const STAFF_ONLY_KEYS = ['proof_filename', 'reviewed_by_staff_id', 'reviewedByStaff', 'changed_by_staff_id', 'note', 'user_id', 'coupon_id', 'guest_latitude', 'guest_longitude', 'guest_token', 'token_hash', 'shipping_address_id', 'variant', 'user', 'email'];

function expectCustomerSafe(body, { secrets = [] } = {}) {
  const keys = keysOf(body);
  for (const key of STAFF_ONLY_KEYS) expect(keys.has(key)).toBe(false);
  const text = JSON.stringify(body);
  for (const secret of secrets) expect(text).not.toContain(secret);
}

let failures = 0; // failed lookups sent from this file's (single) test IP

describe('phone normalization', () => {
  it.each([
    ['9800000009', '9800000009'],
    ['+977 980-000-0009', '9800000009'],
    ['+9779800000009', '9800000009'],
    ['977 9800000009', '9800000009'],
    ['09800000009', '9800000009'],
    ['(980) 000 0009', '9800000009'],
    ['980000000', null],
    ['1800000009', null],
    ['98000000090', null],
    ['abc', null],
  ])('%s -> %s', (raw, expected) => {
    expect(normalizeNepalPhone(raw)).toBe(expected);
  });
});

describe('public lookup', () => {
  let order;
  beforeAll(async () => { order = await guestOrder('lookup'); });

  it('finds a guest order by order ID + phone in any common format', async () => {
    for (const phone of [GUEST_PHONE, '+977 980-000-0009', '09800000009']) {
      const res = await track(` ${order.number.toLowerCase()} `, phone);
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body.data).toMatchObject({ order_number: order.number, status: 'pending', is_guest: true });
      expect(res.body.data.paymentConfirmation).toMatchObject({ method: 'advance_qr', status: 'pending' });
      expect(res.body.data.payment_summary).toMatchObject({ advance_paid: 0, remaining_cod: order.total });
    }
  });

  it('shows a summary only: no ids, phone, street address or token', async () => {
    const { body } = await track(order.number, GUEST_PHONE);
    expect(body.data.id).toBeUndefined();
    expect(body.data.delivery).toEqual({ name: 'E2E track-lookup', lines: ['Kathmandu', 'Kathmandu'], landmark: null });
    expect(body.data.items[0]).toMatchObject({ product_name_snap: 'E2E Tracking fixture', model: 'iPhone 12', quantity: 1, unit_price: 699 });
    expect(body.data.items[0].id).toBeUndefined();
    expectCustomerSafe(body, { secrets: [order.token, GUEST_PHONE, 'E2E fixture lane'] });
  });

  it('gives the same answer for a wrong phone and an unknown order number', async () => {
    const wrongPhone = await track(order.number, '9811111111');
    const unknown = await track('CV-20260101-ZZZZZZ', GUEST_PHONE);
    const unparseablePhone = await track(order.number, '12345678901');
    failures += 3;
    for (const res of [wrongPhone, unknown, unparseablePhone]) {
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('order_lookup_failed');
      expect(res.body.error.message).toBe(wrongPhone.body.error.message);
    }
    expect(JSON.stringify(wrongPhone.body)).not.toContain(order.number);
  });

  it('rejects malformed input before any lookup', async () => {
    for (const body of [
      { order_number: '12345', phone: GUEST_PHONE },
      { order_number: 'CV-2026-ABC', phone: GUEST_PHONE },
      { order_number: "CV-20260101-ZZZZZZ' OR 1=1", phone: GUEST_PHONE },
      { order_number: order.number, phone: '' },
      { order_number: order.number },
    ]) {
      const res = await api().post('/api/order-tracking').send(body);
      expect(res.status).toBe(422);
      failures += 1;
    }
  });

  it('tracks a signed-in customer order by its shipping address phone', async () => {
    const placed = await placeCustomerOrder('customerA', [{ sku: SKU.tracking, quantity: 1 }]);
    expect(placed.status).toBe(201);
    const address = await db.Address.findByPk((await db.Order.findByPk(placed.body.data.id)).shipping_address_id);
    const res = await track(placed.body.data.order_number, address.phone);
    expect(res.status).toBe(200);
    expect(res.body.data.is_guest).toBe(false);
    expectCustomerSafe(res.body, { secrets: [address.line1] });
    await api().post(`/api/orders/${placed.body.data.id}/cancel`).set(auth(await login('customerA')));
  });
});

describe('payment and order states', () => {
  it('proof uploaded, then rejected (with its customer-facing reason), then approved', async () => {
    const order = await guestOrder('proof');
    const upload = await uploadProof(order.token);
    expect(upload.status).toBe(200);
    const { proof_filename: proofFile } = await confirmationFor(order.id);
    let res = await track(order.number, GUEST_PHONE);
    expect(res.body.data.paymentConfirmation.status).toBe('proof_uploaded');
    expectCustomerSafe(res.body, { secrets: [proofFile] });

    await review(order.id, 'reject', 'E2E: screenshot unreadable');
    res = await track(order.number, GUEST_PHONE);
    expect(res.body.data.paymentConfirmation).toMatchObject({ status: 'rejected', admin_note: 'E2E: screenshot unreadable' });

    expect((await uploadProof(order.token)).status).toBe(200);
    await review(order.id, 'approve', 'E2E internal: matched eSewa 4411');
    res = await track(order.number, GUEST_PHONE);
    expect(res.body.data).toMatchObject({ status: 'processing' });
    expect(res.body.data.paymentConfirmation).toMatchObject({ status: 'approved', admin_note: null });
    expect(res.body.data.payment_summary).toMatchObject({ advance_paid: 100, remaining_cod: order.total - 100 });
    expectCustomerSafe(res.body, { secrets: ['E2E internal'] });
    expect(res.body.data.statusHistory.map((h) => h.status)).toEqual(['pending', 'processing']);
  });

  it('COD requested, then confirmed: the whole total is due on delivery', async () => {
    const order = await guestOrder('cod');
    expect((await api().post(`/api/guest-checkout/orders/${order.token}/payment-method/cod`)).status).toBe(200);
    let res = await track(order.number, GUEST_PHONE);
    expect(res.body.data.paymentConfirmation).toMatchObject({ method: 'whatsapp_cod', status: 'cod_pending' });
    await review(order.id, 'approve');
    res = await track(order.number, GUEST_PHONE);
    expect(res.body.data.paymentConfirmation.status).toBe('cod_confirmed');
    expect(res.body.data.payment_summary).toMatchObject({ method: 'whatsapp_cod', advance_paid: 0, remaining_cod: order.total });
  });

  it('shipped and delivered, with staff notes kept internal everywhere', async () => {
    const order = await guestOrder('ship');
    expect((await uploadProof(order.token)).status).toBe(200);
    await review(order.id, 'approve');
    await setStatus(order.id, 'shipped', 'E2E staff-only: rider Ram, fragile');
    let res = await track(order.number, GUEST_PHONE);
    expect(res.body.data.status).toBe('shipped');
    expectCustomerSafe(res.body, { secrets: ['staff-only'] });
    const guestView = await api().get(`/api/guest-checkout/orders/${order.token}`);
    expect(guestView.status).toBe(200);
    expectCustomerSafe(guestView.body, { secrets: ['staff-only'] });
    await setStatus(order.id, 'delivered');
    res = await track(order.number, GUEST_PHONE);
    expect(res.body.data.statusHistory.map((h) => h.status)).toEqual(['pending', 'processing', 'shipped', 'delivered']);
  });

  it('cancelled by the guest, and cancelled for payment timeout', async () => {
    const byGuest = await guestOrder('cancel');
    const cancelled = await api().post(`/api/guest-checkout/orders/${byGuest.token}/cancel`);
    expect(cancelled.status).toBe(200);
    expectCustomerSafe(cancelled.body);
    expect((await track(byGuest.number, GUEST_PHONE)).body.data).toMatchObject({ status: 'cancelled', cancellation_reason: 'guest' });

    const lapsed = await guestOrder('timeout');
    await db.InventoryReservation.update({ expires_at: new Date(Date.now() - 1000) }, { where: { order_id: lapsed.id } });
    await db.sequelize.query('UPDATE order_payment_confirmations SET updated_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 360000 SECOND) WHERE order_id = ?', { replacements: [lapsed.id] });
    await cancelIfStale(lapsed.id);
    expect((await track(lapsed.number, GUEST_PHONE)).body.data).toMatchObject({ status: 'cancelled', cancellation_reason: 'payment_timeout' });
  });
});

describe('owner views stay customer-safe', () => {
  it('account order detail, list and cancel responses carry no staff-only fields', async () => {
    const customer = await login('customerA');
    const placed = await placeCustomerOrder('customerA', [{ sku: SKU.tracking, quantity: 1 }]);
    expect(placed.status).toBe(201);
    expectCustomerSafe(placed.body);
    const detail = await api().get(`/api/orders/${placed.body.data.id}`).set(auth(customer));
    expect(detail.body.data).toMatchObject({ id: placed.body.data.id, delivery: expect.objectContaining({ phone: expect.any(String) }) });
    expectCustomerSafe(detail.body);
    expectCustomerSafe((await api().get('/api/orders').set(auth(customer))).body);
    const cancelled = await api().post(`/api/orders/${placed.body.data.id}/cancel`).set(auth(customer));
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data.status).toBe('cancelled');
    expectCustomerSafe(cancelled.body);
  });

  it('the staff order view (invoice and label data) needs manage_orders', async () => {
    const order = await guestOrder('staff-view');
    expect((await api().get(`/api/admin/orders/${order.id}`)).status).toBe(401);
    expect((await api().get(`/api/admin/orders/${order.id}`).set(auth(await login('customerA')))).status).toBe(403);
    const res = await api().get(`/api/admin/orders/${order.id}`).set(auth(await staff()));
    expect(res.status).toBe(200);
    expect(res.body.data.items[0]).toMatchObject({ model: 'iPhone 12', unit_price: '699.00', product_name_snap: 'E2E Tracking fixture' });
    expect(res.body.data.payment_summary).toMatchObject({ advance_paid: 0, remaining_cod: order.total });
    await api().post(`/api/guest-checkout/orders/${order.token}/cancel`);
  });
});

describe('rate limits', () => {
  it('ten failed lookups for one order number block that order, even with the right phone', async () => {
    const order = await guestOrder('guess');
    for (let i = 0; i < 10; i += 1) {
      expect((await track(order.number, `98${String(10000000 + i)}`)).status).toBe(404);
      failures += 1;
    }
    const blocked = await track(order.number, GUEST_PHONE);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('rate_limited');
    failures += 1;
    // Other orders from the same IP are unaffected.
    const other = await guestOrder('guess-other');
    expect((await track(other.number, GUEST_PHONE)).status).toBe(200);
  });

  it('successful lookups never count; 30 failures from one IP then block it', async () => {
    const order = await guestOrder('ip');
    for (let i = 0; i < 40; i += 1) expect((await track(order.number, GUEST_PHONE)).status).toBe(200);
    expect(failures).toBeLessThan(30);
    while (failures < 30) {
      const random = `CV-20260101-${crypto.randomBytes(3).toString('hex').toUpperCase().replace(/[ILOU]/g, 'A')}`;
      expect((await track(random, GUEST_PHONE)).status).toBe(404);
      failures += 1;
    }
    const blocked = await track(order.number, GUEST_PHONE);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('rate_limited');
  });
});
