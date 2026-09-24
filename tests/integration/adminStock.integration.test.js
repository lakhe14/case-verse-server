'use strict';

/**
 * Admin physical-stock edits are guarded by active reservations.
 * DB-backed against caseverse_e2e. Uses a variant no other suite touches.
 */

const inventory = require('../../services/inventory.service');
const { api, db, login, auth, SKU, variant, inventoryOf, placeGuestOrder } = require('./helpers');

const sku = SKU.pinkBow17;
const tokens = [];

afterEach(async () => {
  // Release every hold this suite created so the next scenario starts at reserved 0.
  while (tokens.length) await api().post(`/api/guest-checkout/orders/${tokens.pop()}/cancel`);
});
afterAll(() => db.sequelize.close());

async function setPhysicalDirect(quantity) {
  await db.ProductVariant.update({ stock_quantity: quantity }, { where: { sku } });
}

async function hold(quantity, label = 'admin-stock') {
  const placed = await placeGuestOrder([{ sku, quantity }], { label });
  expect(placed.status).toBe(201);
  tokens.push(placed.body.guest_token);
  return placed.body.data.id;
}

/** physical 10, reserved 6, available 4 */
async function tenWithSixReserved() {
  await setPhysicalDirect(10);
  const orderId = await hold(6);
  expect(await inventoryOf(sku)).toEqual({ physical: 10, reserved: 6, available: 4 });
  return orderId;
}

async function adminSetStock(quantity, kind = 'limitedStaff') {
  const v = await variant(sku);
  const req = api().put(`/api/admin/products/${v.product_id}/variants/${v.id}`).send({ stock_quantity: quantity });
  return kind ? req.set(auth(await login(kind))) : req;
}

const adminRow = (res) => res.body.data.variants.find((v) => v.sku === sku);

describe('reserved floor', () => {
  it('A: setting physical stock below the active reserved quantity is blocked and changes nothing', async () => {
    await tenWithSixReserved();
    const res = await adminSetStock(5);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'stock_below_reserved',
      message: 'Stock cannot be set below the quantity currently reserved for active orders.',
      details: { physical_stock: 10, reserved_quantity: 6, minimum_allowed_stock: 6 },
    });
    // No order, customer or reservation identifiers leak into the error.
    expect(Object.keys(res.body.error.details).sort()).toEqual(['minimum_allowed_stock', 'physical_stock', 'reserved_quantity']);
    expect(await inventoryOf(sku)).toEqual({ physical: 10, reserved: 6, available: 4 });
  });

  it('A2: a combined edit that would breach the floor rolls back the other field changes too', async () => {
    await tenWithSixReserved();
    const v = await variant(sku);
    const res = await api().put(`/api/admin/products/${v.product_id}/variants/${v.id}`).set(auth(await login('limitedStaff')))
      .send({ price: 1234, stock_quantity: 0 });
    expect(res.status).toBe(409);
    expect(Number((await variant(sku)).price)).toBe(Number(v.price));
  });

  it('B: setting physical stock exactly to the reserved quantity succeeds with 0 available', async () => {
    await tenWithSixReserved();
    const res = await adminSetStock(6);
    expect(res.status).toBe(200);
    expect(adminRow(res)).toMatchObject({ stock_quantity: 6, reserved_quantity: 6, available_quantity: 0 });
    expect(await inventoryOf(sku)).toEqual({ physical: 6, reserved: 6, available: 0 });
  });

  it('C: increasing physical stock succeeds', async () => {
    await tenWithSixReserved();
    const res = await adminSetStock(20);
    expect(res.status).toBe(200);
    expect(adminRow(res)).toMatchObject({ stock_quantity: 20, reserved_quantity: 6, available_quantity: 14 });
  });

  it('D: an expired hold does not count, whether or not the sweep has marked it', async () => {
    await setPhysicalDirect(10);
    const orderId = await hold(6);
    await db.InventoryReservation.update({ expires_at: new Date(Date.now() - 1000) }, { where: { order_id: orderId } });
    // Still status 'active' but past expires_at.
    let res = await adminSetStock(2);
    expect(res.status).toBe(200);
    expect(adminRow(res)).toMatchObject({ stock_quantity: 2, reserved_quantity: 0, available_quantity: 2 });
    await inventory.expireStale();
    expect((await db.InventoryReservation.findOne({ where: { order_id: orderId } })).status).toBe('expired');
    res = await adminSetStock(0);
    expect(res.status).toBe(200);
  });

  it('E: a released hold does not count', async () => {
    await setPhysicalDirect(10);
    const orderId = await hold(6);
    expect((await api().post(`/api/guest-checkout/orders/${tokens.pop()}/cancel`)).status).toBe(200);
    expect((await db.InventoryReservation.findOne({ where: { order_id: orderId } })).status).toBe('released');
    const res = await adminSetStock(0);
    expect(res.status).toBe(200);
    expect(await inventoryOf(sku)).toEqual({ physical: 0, reserved: 0, available: 0 });
  });

  it('F: a committed reservation is already deducted and does not count as reserved', async () => {
    await setPhysicalDirect(10);
    const orderId = await hold(6);
    const token = tokens.pop(); // confirmed orders are not cancelled by afterEach
    expect((await api().post(`/api/guest-checkout/orders/${token}/payment-method/cod`)).status).toBe(200);
    const confirmation = await db.OrderPaymentConfirmation.findOne({ where: { order_id: orderId } });
    const approved = await api().post(`/api/admin/payment-confirmations/${confirmation.id}/approve`).set(auth(await login('staff'))).send({});
    expect(approved.status).toBe(200);
    expect((await db.InventoryReservation.findOne({ where: { order_id: orderId } })).status).toBe('committed');
    expect(await inventoryOf(sku)).toEqual({ physical: 4, reserved: 0, available: 4 });
    const res = await adminSetStock(0);
    expect(res.status).toBe(200);
    expect(await inventoryOf(sku)).toEqual({ physical: 0, reserved: 0, available: 0 });
  });

  it('non-stock edits are not blocked by the floor', async () => {
    await tenWithSixReserved();
    const v = await variant(sku);
    const res = await api().put(`/api/admin/products/${v.product_id}/variants/${v.id}`).set(auth(await login('limitedStaff')))
      .send({ price: Number(v.price), stock_quantity: 10, is_active: true });
    expect(res.status).toBe(200);
    expect(await inventoryOf(sku)).toEqual({ physical: 10, reserved: 6, available: 4 });
  });

  it('a variant id is only editable through its own product', async () => {
    const v = await variant(sku);
    const other = await variant(SKU.glossyWhite);
    const res = await api().put(`/api/admin/products/${other.product_id}/variants/${v.id}`).set(auth(await login('limitedStaff'))).send({ stock_quantity: 3 });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('variant_not_found');
  });
});

describe('public vs admin stock semantics', () => {
  it('storefront shows only AVAILABLE; admin sees physical, reserved and available', async () => {
    await tenWithSixReserved();
    const v = await variant(sku);
    const product = await db.Product.findByPk(v.product_id);
    const pub = (await api().get(`/api/products/${product.slug}`)).body.data.variants.find((x) => x.sku === sku);
    expect(pub.stock_quantity).toBe(4);
    expect(pub).not.toHaveProperty('reserved_quantity');
    expect(pub).not.toHaveProperty('available_quantity');
    expect(pub).not.toHaveProperty('physical_stock');
    const list = (await api().get('/api/products?limit=60')).body.data.flatMap((p) => p.variants).find((x) => x.sku === sku);
    expect(list.stock_quantity).toBe(4);
    expect(list).not.toHaveProperty('reserved_quantity');
    const admin = await api().get(`/api/admin/products/${v.product_id}`).set(auth(await login('limitedStaff')));
    expect(adminRow(admin)).toMatchObject({ stock_quantity: 10, reserved_quantity: 6, available_quantity: 4 });
  });
});

describe('permissions', () => {
  it('only staff with manage_products can edit stock', async () => {
    await setPhysicalDirect(10);
    expect((await adminSetStock(7, null)).status).toBe(401);
    expect((await adminSetStock(7, 'customerA')).status).toBe(403);
    const orderManager = await adminSetStock(7, 'staff'); // Order Manager: no manage_products
    expect(orderManager.status).toBe(403);
    expect(orderManager.body.error.code).toBe('missing_permission');
    expect((await inventoryOf(sku)).physical).toBe(10);
    expect((await adminSetStock(7, 'limitedStaff')).status).toBe(200);
    expect((await inventoryOf(sku)).physical).toBe(7);
  });
});

describe('concurrency', () => {
  it('admin reduction racing a customer reservation never leaves physical below active reserved', async () => {
    const outcomes = new Set();
    for (let round = 0; round < 6; round += 1) {
      await setPhysicalDirect(1);
      const v = await variant(sku);
      const staff = await login('limitedStaff');
      const adminReq = api().put(`/api/admin/products/${v.product_id}/variants/${v.id}`).set(auth(staff)).send({ stock_quantity: 0 });
      const orderReq = placeGuestOrder([{ sku, quantity: 1 }], { label: `admin-race-${round}` });
      const [adminRes, orderRes] = round % 2 ? await Promise.all([orderReq, adminReq]).then(([o, a]) => [a, o]) : await Promise.all([adminReq, orderReq]);
      if (orderRes.status === 201) tokens.push(orderRes.body.guest_token);

      const stock = await inventoryOf(sku);
      expect(stock.physical).toBeGreaterThanOrEqual(stock.reserved);
      if (orderRes.status === 201) {
        // Order won the lock: the admin reduction must have been refused.
        expect(adminRes.status).toBe(409);
        expect(adminRes.body.error.code).toBe('stock_below_reserved');
        expect(stock).toEqual({ physical: 1, reserved: 1, available: 0 });
        outcomes.add('order-first');
      } else {
        // Admin won the lock: the order found nothing available.
        expect(adminRes.status).toBe(200);
        expect(orderRes.status).toBe(400);
        expect(orderRes.body.error.code).toBe('insufficient_stock');
        expect(stock).toEqual({ physical: 0, reserved: 0, available: 0 });
        outcomes.add('admin-first');
      }
      while (tokens.length) await api().post(`/api/guest-checkout/orders/${tokens.pop()}/cancel`);
    }
    expect(outcomes.size).toBeGreaterThanOrEqual(1);
  });

  it('service level: the guard and write are atomic under concurrent reservation inserts', async () => {
    await setPhysicalDirect(1);
    const v = await variant(sku);
    const [adminResult, orderRes] = await Promise.allSettled([
      db.sequelize.transaction(inventory.STOCK_TX, (t) => inventory.setPhysicalStock(v.id, 0, t)),
      placeGuestOrder([{ sku, quantity: 1 }], { label: 'admin-race-service' }),
    ]);
    if (orderRes.value.status === 201) tokens.push(orderRes.value.body.guest_token);
    const stock = await inventoryOf(sku);
    expect(stock.physical).toBeGreaterThanOrEqual(stock.reserved);
    expect([adminResult.status === 'fulfilled', orderRes.value.status === 201].filter(Boolean)).toHaveLength(1);
  });
});
