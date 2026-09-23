'use strict';

/**
 * Reserve-on-order, deduct-on-confirmation. DB-backed against caseverse_e2e.
 * Letters match the acceptance matrix (A-M).
 */

const inventory = require('../../services/inventory.service');
const {
  api, db, login, auth, SKU, variant, inventoryOf, clearCart, placeCustomerOrder, placeGuestOrder, PNG,
} = require('./helpers');

afterAll(() => db.sequelize.close());

const confirmationFor = (orderId) => db.OrderPaymentConfirmation.findOne({ where: { order_id: orderId } });
const holdsFor = (orderId) => db.InventoryReservation.findAll({ where: { order_id: orderId }, order: [['id', 'ASC']] });

async function uploadProof(orderId) {
  const res = await api().post(`/api/orders/${orderId}/payment-proof`).set(auth(await login('customerA')))
    .attach('proof', PNG, { filename: 'p.png', contentType: 'image/png' });
  expect(res.status).toBe(201);
}

async function approve(orderId) {
  const confirmation = await confirmationFor(orderId);
  return api().post(`/api/admin/payment-confirmations/${confirmation.id}/approve`).set(auth(await login('staff'))).send({});
}

async function publicStock(slug, sku) {
  const res = await api().get(`/api/products/${slug}`);
  return res.body.data.variants.find((v) => v.sku === sku);
}

describe('reservation on order placement', () => {
  it('A: an unpaid customer order holds stock without touching physical stock', async () => {
    const before = await inventoryOf(SKU.glossyWhite);
    const placed = await placeCustomerOrder('customerA', [{ sku: SKU.glossyWhite, quantity: 2 }]);
    expect(placed.status).toBe(201);
    expect(await inventoryOf(SKU.glossyWhite)).toEqual({ physical: before.physical, reserved: before.reserved + 2, available: before.available - 2 });
    const [hold] = await holdsFor(placed.body.data.id);
    expect(hold).toMatchObject({ status: 'active', quantity: 2 });
    const ttl = hold.expires_at.getTime() - Date.now();
    expect(ttl).toBeGreaterThan(55 * 60 * 1000);
    expect(ttl).toBeLessThanOrEqual(60 * 60 * 1000);
    // Storefront sees what can still be sold, with no reservation internals.
    const shown = await publicStock('glossy-white', SKU.glossyWhite);
    expect(shown.stock_quantity).toBe(before.available - 2);
    expect(shown).not.toHaveProperty('reserved_quantity');
    // Admin (Product Manager has manage_products) sees physical, reserved and available explicitly.
    const admin = await api().get(`/api/admin/products/${(await variant(SKU.glossyWhite)).product_id}`).set(auth(await login('limitedStaff')));
    expect(admin.status).toBe(200);
    const row = admin.body.data.variants.find((v) => v.sku === SKU.glossyWhite);
    expect(row).toMatchObject({ stock_quantity: before.physical, reserved_quantity: before.reserved + 2, available_quantity: before.available - 2 });
  });

  it('B: an unpaid guest order holds stock the same way', async () => {
    const before = await inventoryOf(SKU.flameSilver);
    const placed = await placeGuestOrder([{ sku: SKU.flameSilver, quantity: 2 }], { label: 'inv-guest' });
    expect(placed.status).toBe(201);
    expect(await inventoryOf(SKU.flameSilver)).toEqual({ physical: before.physical, reserved: before.reserved + 2, available: before.available - 2 });
    expect((await holdsFor(placed.body.data.id)).map((h) => h.status)).toEqual(['active']);
  });
});

describe('advance payment', () => {
  it('C/D/J: proof upload holds, approval deducts exactly once, repeated approval never deducts again', async () => {
    const before = await inventoryOf(SKU.chetah14);
    const placed = await placeCustomerOrder('customerA', [{ sku: SKU.chetah14, quantity: 2 }]);
    const orderId = placed.body.data.id;

    await uploadProof(orderId);
    expect(await inventoryOf(SKU.chetah14)).toEqual({ physical: before.physical, reserved: before.reserved + 2, available: before.available - 2 });
    const [held] = await holdsFor(orderId);
    expect(held.expires_at.getTime() - Date.now()).toBeGreaterThan(71 * 60 * 60 * 1000);

    expect((await approve(orderId)).status).toBe(200);
    expect(await inventoryOf(SKU.chetah14)).toEqual({ physical: before.physical - 2, reserved: before.reserved, available: before.available - 2 });
    expect((await holdsFor(orderId)).map((h) => h.status)).toEqual(['committed']);
    expect((await db.Order.findByPk(orderId)).status).toBe('processing');

    // Repeated approval through the API is refused, and the commit itself is idempotent.
    expect((await approve(orderId)).status).toBeGreaterThanOrEqual(400);
    const again = await db.sequelize.transaction(inventory.STOCK_TX, (t) => inventory.commitForOrder(orderId, t));
    expect(again).toBe(0);
    expect((await inventoryOf(SKU.chetah14)).physical).toBe(before.physical - 2);
  });

  it('a rejected proof keeps the hold (retryable) on the short window, without deducting', async () => {
    const before = await inventoryOf(SKU.chetah14);
    const placed = await placeCustomerOrder('customerA', [{ sku: SKU.chetah14, quantity: 1 }]);
    await uploadProof(placed.body.data.id);
    const confirmation = await confirmationFor(placed.body.data.id);
    const reject = await api().post(`/api/admin/payment-confirmations/${confirmation.id}/reject`).set(auth(await login('staff'))).send({ note: 'E2E unreadable' });
    expect(reject.status).toBe(200);
    const [hold] = await holdsFor(placed.body.data.id);
    expect(hold.status).toBe('active');
    expect(hold.expires_at.getTime() - Date.now()).toBeLessThanOrEqual(60 * 60 * 1000);
    expect(await inventoryOf(SKU.chetah14)).toEqual({ physical: before.physical, reserved: before.reserved + 1, available: before.available - 1 });
  });
});

describe('cash on delivery', () => {
  it('E/F/K: COD request holds, confirmation deducts exactly once, repeated confirmation never deducts again', async () => {
    const before = await inventoryOf(SKU.bowCherry13);
    const placed = await placeGuestOrder([{ sku: SKU.bowCherry13, quantity: 3 }], { label: 'inv-cod' });
    const token = placed.body.guest_token;
    expect((await api().post(`/api/guest-checkout/orders/${token}/payment-method/cod`)).status).toBe(200);
    expect(await inventoryOf(SKU.bowCherry13)).toEqual({ physical: before.physical, reserved: before.reserved + 3, available: before.available - 3 });

    const orderId = placed.body.data.id;
    expect((await approve(orderId)).status).toBe(200);
    expect((await confirmationFor(orderId)).status).toBe('cod_confirmed');
    expect(await inventoryOf(SKU.bowCherry13)).toEqual({ physical: before.physical - 3, reserved: before.reserved, available: before.available - 3 });

    expect((await approve(orderId)).status).toBeGreaterThanOrEqual(400);
    expect(await db.sequelize.transaction(inventory.STOCK_TX, (t) => inventory.commitForOrder(orderId, t))).toBe(0);
    expect((await inventoryOf(SKU.bowCherry13)).physical).toBe(before.physical - 3);
  });
});

describe('cancellation and expiry', () => {
  it('G / primary rule: an order that never confirms leaves physical stock unchanged and availability restored', async () => {
    const before = await inventoryOf(SKU.bowCherry15);
    const placed = await placeCustomerOrder('customerA', [{ sku: SKU.bowCherry15, quantity: 2 }]);
    expect(await inventoryOf(SKU.bowCherry15)).toEqual({ physical: before.physical, reserved: before.reserved + 2, available: before.available - 2 });
    const cancel = await api().post(`/api/orders/${placed.body.data.id}/cancel`).set(auth(await login('customerA')));
    expect(cancel.status).toBe(200);
    expect(await inventoryOf(SKU.bowCherry15)).toEqual(before);
    expect((await holdsFor(placed.body.data.id)).map((h) => h.status)).toEqual(['released']);
  });

  it('cancelling a confirmed order restocks physical stock exactly once', async () => {
    const before = await inventoryOf(SKU.bowCherry15);
    const placed = await placeCustomerOrder('customerA', [{ sku: SKU.bowCherry15, quantity: 1 }]);
    await uploadProof(placed.body.data.id);
    expect((await approve(placed.body.data.id)).status).toBe(200);
    expect((await inventoryOf(SKU.bowCherry15)).physical).toBe(before.physical - 1);
    const staff = await login('staff');
    for (let i = 0; i < 2; i += 1) {
      const res = await api().put(`/api/admin/orders/${placed.body.data.id}/status`).set(auth(staff)).send({ status: 'cancelled' });
      expect(res.status).toBe(200);
    }
    expect(await inventoryOf(SKU.bowCherry15)).toEqual(before);
    expect((await holdsFor(placed.body.data.id)).map((h) => h.status)).toEqual(['restocked']);
  });

  it('H: an expired hold stops counting immediately; physical stock never moves', async () => {
    const before = await inventoryOf(SKU.pinkFloral17Pro);
    const placed = await placeGuestOrder([{ sku: SKU.pinkFloral17Pro, quantity: 2 }], { label: 'inv-expiry' });
    expect((await inventoryOf(SKU.pinkFloral17Pro)).available).toBe(before.available - 2);
    await db.InventoryReservation.update({ expires_at: new Date(Date.now() - 1000) }, { where: { order_id: placed.body.data.id } });
    expect(await inventoryOf(SKU.pinkFloral17Pro)).toEqual(before);
    expect(await inventory.expireStale()).toBeGreaterThanOrEqual(1);
    expect((await holdsFor(placed.body.data.id)).map((h) => h.status)).toEqual(['expired']);
    expect(await inventoryOf(SKU.pinkFloral17Pro)).toEqual(before);
  });

  it('confirming a lapsed hold re-validates: commits if still available, refuses if sold out', async () => {
    const sku = SKU.pinkFloral17Pro;
    const lapsedOk = await placeGuestOrder([{ sku, quantity: 1 }], { label: 'inv-lapsed-ok' });
    await api().post(`/api/guest-checkout/orders/${lapsedOk.body.guest_token}/payment-method/cod`);
    await db.InventoryReservation.update({ expires_at: new Date(Date.now() - 1000) }, { where: { order_id: lapsedOk.body.data.id } });
    const physical = (await inventoryOf(sku)).physical;
    expect((await approve(lapsedOk.body.data.id)).status).toBe(200);
    expect((await inventoryOf(sku)).physical).toBe(physical - 1);

    const lapsedGone = await placeGuestOrder([{ sku, quantity: 1 }], { label: 'inv-lapsed-gone' });
    await api().post(`/api/guest-checkout/orders/${lapsedGone.body.guest_token}/payment-method/cod`);
    await db.InventoryReservation.update({ expires_at: new Date(Date.now() - 1000) }, { where: { order_id: lapsedGone.body.data.id } });
    const v = await variant(sku);
    const { available } = await inventoryOf(sku);
    const takers = available > 0 ? await placeGuestOrder([{ sku, quantity: available }], { label: 'inv-lapsed-taker' }) : null;
    if (takers) expect(takers.status).toBe(201);
    const before = await inventoryOf(sku);
    const refused = await approve(lapsedGone.body.data.id);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('reservation_lapsed_insufficient_stock');
    expect(await inventoryOf(sku)).toEqual(before);
    expect((await confirmationFor(lapsedGone.body.data.id)).status).toBe('cod_pending');
    expect(v.stock_quantity).toBe(before.physical);
  });
});

describe('concurrency and aggregation', () => {
  it('I: two customers racing for the last unit: one reservation, one insufficient_stock, no oversell', async () => {
    const sku = SKU.chetah15Pro;
    const v = await variant(sku);
    const original = v.stock_quantity;
    await v.update({ stock_quantity: 1 });
    try {
      const a = await login('customerA');
      const b = await login('customerB');
      for (const session of [a, b]) {
        await clearCart(session);
        expect((await api().post('/api/cart/items').set(auth(session)).send({ variant_id: v.id, quantity: 1 })).status).toBe(201);
      }
      const address = async (s) => (await api().get('/api/addresses').set(auth(s))).body.data.find((x) => x.is_default).id;
      const [ra, rb] = await Promise.all([
        api().post('/api/orders').set(auth(a)).send({ shipping_address_id: await address(a), parcelmoover_destination_id: 'e2e-kathmandu' }),
        api().post('/api/orders').set(auth(b)).send({ shipping_address_id: await address(b), parcelmoover_destination_id: 'e2e-kathmandu' }),
      ]);
      expect([ra.status, rb.status].sort()).toEqual([201, 400]);
      expect([ra, rb].find((r) => r.status === 400).body.error.code).toBe('insufficient_stock');
      expect(await inventoryOf(sku)).toEqual({ physical: 1, reserved: 1, available: 0 });

      // Two guests racing for the same last unit behave the same way.
      const winner = [ra, rb].find((r) => r.status === 201).body.data.id;
      const owner = ra.status === 201 ? a : b;
      await api().post(`/api/orders/${winner}/cancel`).set(auth(owner));
      const guests = await Promise.all([
        placeGuestOrder([{ sku, quantity: 1 }], { label: 'inv-race-1' }),
        placeGuestOrder([{ sku, quantity: 1 }], { label: 'inv-race-2' }),
      ]);
      expect(guests.map((g) => g.status).sort()).toEqual([201, 400]);
      expect(await inventoryOf(sku)).toEqual({ physical: 1, reserved: 1, available: 0 });
      for (const session of [a, b]) await clearCart(session);
    } finally {
      await v.reload();
      await v.update({ stock_quantity: original });
    }
  });

  it('L: an idempotent guest replay never adds a second reservation', async () => {
    const key = require('./helpers').newIdempotencyKey();
    const before = await inventoryOf(SKU.bowCherry13);
    const first = await placeGuestOrder([{ sku: SKU.bowCherry13, quantity: 1 }], { label: 'inv-idem', key });
    const replay = await placeGuestOrder([{ sku: SKU.bowCherry13, quantity: 1 }], { label: 'inv-idem', key });
    expect([first.status, replay.status]).toEqual([201, 200]);
    expect(await db.InventoryReservation.count({ where: { order_id: first.body.data.id } })).toBe(1);
    expect((await inventoryOf(SKU.bowCherry13)).reserved).toBe(before.reserved + 1);
  });

  it('M: duplicate guest lines are checked in aggregate against AVAILABLE (not physical) stock', async () => {
    const sku = SKU.chetah15Pro;
    const { available, physical } = await inventoryOf(sku);
    const holdQty = Math.min(3, available - 2);
    await placeGuestOrder([{ sku, quantity: holdQty }], { label: 'inv-agg-hold' });
    const left = available - holdQty;
    const half = Math.ceil((left + 1) / 2);
    const tooMany = await placeGuestOrder([{ sku, quantity: half }, { sku, quantity: left + 1 - half }], { label: 'inv-agg-over' });
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.error.code).toBe('insufficient_stock');
    // Within physical stock, but over what is still available.
    expect(left + 1).toBeLessThanOrEqual(physical);
    const fits = await placeGuestOrder([{ sku, quantity: 1 }, { sku, quantity: left - 1 }], { label: 'inv-agg-fit' });
    expect(fits.status).toBe(201);
    expect((await inventoryOf(sku)).available).toBe(0);
  });

  it('cart validation uses available stock', async () => {
    const sku = SKU.chetah15Pro;
    const { available } = await inventoryOf(sku);
    const customer = await login('customerB');
    await clearCart(customer);
    const res = await api().post('/api/cart/items').set(auth(customer)).send({ variant_id: (await variant(sku)).id, quantity: available + 1 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('insufficient_stock');
  });
});

describe('legacy orders (placed before reservations existed)', () => {
  it('confirmation deducts nothing more and cancellation restocks from items, once', async () => {
    const sku = SKU.glossyWhite;
    const placed = await placeGuestOrder([{ sku, quantity: 1 }], { label: 'inv-legacy' });
    const orderId = placed.body.data.id;
    // Simulate the old model: no reservation rows, stock already deducted at placement.
    await db.InventoryReservation.destroy({ where: { order_id: orderId } });
    const v = await variant(sku);
    await v.update({ stock_quantity: v.stock_quantity - 1 });
    const deducted = await inventoryOf(sku);

    await api().post(`/api/guest-checkout/orders/${placed.body.guest_token}/payment-method/cod`);
    expect((await approve(orderId)).status).toBe(200);
    expect(await inventoryOf(sku)).toEqual(deducted);

    const staff = await login('staff');
    await api().put(`/api/admin/orders/${orderId}/status`).set(auth(staff)).send({ status: 'cancelled' });
    await api().put(`/api/admin/orders/${orderId}/status`).set(auth(staff)).send({ status: 'cancelled' });
    expect((await inventoryOf(sku)).physical).toBe(deducted.physical + 1);
  });
});
