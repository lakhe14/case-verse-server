'use strict';

/**
 * Coupon usage limits under concurrent checkout. Placement locks the coupon
 * row and re-checks active uses inside the order transaction, so no amount of
 * concurrent traffic commits more than N active uses. DB-backed against
 * caseverse_e2e with the fixture coupons from scripts/e2e/fixtureData.js.
 */

const loyalty = require('../../services/loyalty.service');
const { api, db, login, auth, SKU, variant, inventoryOf, clearCart, placeGuestOrder, newIdempotencyKey } = require('./helpers');

const sku = SKU.pinkBow13ProMax;
const CUSTOMERS = ['customerA', 'customerB', 'customerC', 'customerD', 'customerE'];
// A different variant per customer: orders for the same variant already
// serialize on the variant lock, which would hide a coupon race.
const OWN_SKU = { customerA: SKU.pinkBow13ProMax, customerB: SKU.pinkBow12ProMax, customerC: SKU.pinkBow14ProMax, customerD: SKU.chetah15Pro, customerE: SKU.bowCherry15 };
const placed = []; // [kind, orderId] still open after a test

afterEach(async () => {
  // Cancel every unpaid order this suite left open: releases its hold and coupon use.
  while (placed.length) {
    const [kind, id] = placed.pop();
    await api().post(`/api/orders/${id}/cancel`).set(auth(await login(kind)));
  }
  for (const kind of CUSTOMERS) await clearCart(await login(kind));
});
afterAll(() => db.sequelize.close());

const couponId = async (code) => (await db.Coupon.findOne({ where: { code } })).id;
const activeUses = async (code, where = {}) => db.CouponUsage.count({ where: { coupon_id: await couponId(code), released_at: null, ...where } });
const allUses = async (code) => db.CouponUsage.count({ where: { coupon_id: await couponId(code) } });

async function prepareCart(kind, forSku = OWN_SKU[kind], quantity = 1) {
  const session = await login(kind);
  await clearCart(session);
  const res = await api().post('/api/cart/items').set(auth(session)).send({ variant_id: (await variant(forSku)).id, quantity });
  if (res.status !== 201) throw new Error(`cart add failed for ${kind}: ${res.status} ${res.body?.error?.code}`);
  const addresses = await api().get('/api/addresses').set(auth(session));
  return { kind, session, addressId: addresses.body.data.find((a) => a.is_default).id };
}

function submit({ kind, session, addressId }, coupon, extra = {}) {
  return api().post('/api/orders').set(auth(session))
    .send({ shipping_address_id: addressId, parcelmoover_destination_id: 'e2e-kathmandu', ...(coupon ? { coupon_code: coupon } : {}), ...extra })
    .then((res) => {
      if (res.status === 201) placed.push([kind, res.body.data.id]);
      return res;
    });
}

const cartCount = async (session) => (await api().get('/api/cart').set(auth(session))).body.data.items.length;

describe('global limit', () => {
  it('limit 1: two customers at once, exactly one gets the coupon, the loser keeps a full cart (3 rounds)', async () => {
    for (let round = 0; round < 3; round += 1) {
      const carts = [await prepareCart('customerA'), await prepareCart('customerB')];
      const before = { A: await inventoryOf(OWN_SKU.customerA), B: await inventoryOf(OWN_SKU.customerB) };
      const results = await Promise.all(carts.map((cart) => submit(cart, 'E2EONCE')));
      expect(results.map((r) => r.status).sort()).toEqual([201, 400]);
      const loser = results.find((r) => r.status === 400);
      expect(loser.body.error).toEqual(expect.objectContaining({ code: 'coupon_exhausted', message: 'Sorry, this coupon has reached its usage limit.' }));
      expect(JSON.stringify(loser.body)).not.toMatch(/SELECT|lock|count|Sequelize/i);
      expect(await activeUses('E2EONCE')).toBe(1);
      expect(await db.Order.count({ where: { coupon_id: await couponId('E2EONCE'), status: 'pending' } })).toBe(1);
      // The failed placement rolled back entirely: one hold, the loser's cart untouched.
      const after = { A: await inventoryOf(OWN_SKU.customerA), B: await inventoryOf(OWN_SKU.customerB) };
      expect(after.A.reserved + after.B.reserved).toBe(before.A.reserved + before.B.reserved + 1);
      expect(await cartCount(carts[results.indexOf(loser)].session)).toBe(1);
      const winner = results.find((r) => r.status === 201).body.data;
      expect(Number(winner.discount_amount)).toBeGreaterThan(0);
      // Cancel the winner so the next round starts with the use released.
      const [kind, id] = placed.pop();
      expect((await api().post(`/api/orders/${id}/cancel`).set(auth(await login(kind)))).status).toBe(200);
      expect(await activeUses('E2EONCE')).toBe(0);
    }
  });

  it('limit 3: five customers at once, exactly three succeed and two are refused', async () => {
    const carts = [];
    for (const kind of CUSTOMERS) carts.push(await prepareCart(kind));
    const results = await Promise.all(carts.map((cart) => submit(cart, 'E2ETHREE')));
    expect(results.filter((r) => r.status === 201)).toHaveLength(3);
    const refused = results.filter((r) => r.status !== 201);
    expect(refused).toHaveLength(2);
    for (const r of refused) expect([r.status, r.body.error.code]).toEqual([400, 'coupon_exhausted']);
    expect(await activeUses('E2ETHREE')).toBe(3);
    expect(await db.Order.count({ where: { coupon_id: await couponId('E2ETHREE'), status: 'pending' } })).toBe(3);
  });
});

describe('per-customer limit', () => {
  it('limit 1 per customer: concurrent submits from one customer record one use; a later attempt is refused, others may still use it', async () => {
    const cart = await prepareCart('customerA');
    const results = await Promise.all([submit(cart, 'E2EUSERONCE'), submit(cart, 'E2EUSERONCE')]);
    // One cart: the cart lock serializes them; the second finds it emptied (or the coupon used).
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    const other = results.find((r) => r.status !== 201);
    expect(other.status).toBe(400);
    expect(['cart_empty', 'coupon_used_by_user']).toContain(other.body.error.code);
    const customerA = (await login('customerA')).profile.id;
    expect(await activeUses('E2EUSERONCE', { user_id: customerA })).toBe(1);

    const again = await submit(await prepareCart('customerA'), 'E2EUSERONCE');
    expect(again.status).toBe(400);
    expect(again.body.error).toEqual(expect.objectContaining({ code: 'coupon_used_by_user', message: 'You have already used this coupon the maximum number of times.' }));
    expect(await activeUses('E2EUSERONCE', { user_id: customerA })).toBe(1);

    expect((await submit(await prepareCart('customerB'), 'E2EUSERONCE')).status).toBe(201);
    expect(await activeUses('E2EUSERONCE')).toBe(2);
  });
});

describe('release and consumption', () => {
  it('an unpaid cancellation frees the single use for the next customer; history keeps both rows', async () => {
    const first = await submit(await prepareCart('customerA'), 'E2EONCE');
    expect(first.status).toBe(201);
    expect((await submit(await prepareCart('customerB'), 'E2EONCE')).status).toBe(400);
    const [kind, id] = placed.pop();
    expect((await api().post(`/api/orders/${id}/cancel`).set(auth(await login(kind)))).status).toBe(200);
    expect((await db.CouponUsage.findOne({ where: { order_id: id } })).released_at).not.toBeNull();
    expect(await activeUses('E2EONCE')).toBe(0);

    const second = await submit(await prepareCart('customerB'), 'E2EONCE');
    expect(second.status).toBe(201);
    expect(await activeUses('E2EONCE')).toBe(1);
    expect(await allUses('E2EONCE')).toBeGreaterThanOrEqual(2);
  });

  it('a paid order keeps its use even when cancelled later; the next customer is refused', async () => {
    const paid = await submit(await prepareCart('customerA'), 'E2EPAIDONCE');
    expect(paid.status).toBe(201);
    const [kind, id] = placed.pop();
    const customer = await login(kind);
    expect((await api().post(`/api/orders/${id}/payment-method/cod`).set(auth(customer))).status).toBe(200);
    const staff = await login('staff');
    const confirmation = await db.OrderPaymentConfirmation.findOne({ where: { order_id: id } });
    expect((await api().post(`/api/admin/payment-confirmations/${confirmation.id}/approve`).set(auth(staff)).send({})).status).toBe(200);
    expect((await api().put(`/api/admin/orders/${id}/status`).set(auth(staff)).send({ status: 'cancelled' })).status).toBe(200);
    expect(await activeUses('E2EPAIDONCE')).toBe(1);
    const next = await submit(await prepareCart('customerB'), 'E2EPAIDONCE');
    expect([next.status, next.body.error.code]).toEqual([400, 'coupon_exhausted']);
  });
});

describe('rollback', () => {
  it('a failure after the coupon is recorded rolls the use, the order and the hold back', async () => {
    const customer = await login('customerA');
    await db.LoyaltyTransaction.create({ user_id: customer.profile.id, order_id: null, points: 20, type: 'adjustment', note: 'E2E seed points' });
    await loyalty.recalcBalance(customer.profile.id);
    const cart = await prepareCart('customerA');
    const before = await inventoryOf(sku);
    const orders = await db.Order.count({ where: { user_id: customer.profile.id } });
    // Fails after redeemForOrder has inserted the use, inside the same transaction.
    const spy = jest.spyOn(loyalty, 'redeemPoints').mockRejectedValueOnce(new Error('E2E simulated failure after coupon redemption'));
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await submit(cart, 'E2EONCE', { redeem_points: 10 });
      expect(res.status).toBe(500);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      errors.mockRestore();
    }
    expect(await activeUses('E2EONCE')).toBe(0);
    expect(await db.Order.count({ where: { user_id: customer.profile.id } })).toBe(orders);
    expect(await inventoryOf(sku)).toEqual(before);
    expect(await cartCount(cart.session)).toBe(1);
  });

  it('insufficient stock at placement leaves no coupon use behind', async () => {
    const { available } = await inventoryOf(sku);
    const session = await login('customerA');
    await clearCart(session);
    // Cart limits are checked at add time; shrink availability afterwards.
    await api().post('/api/cart/items').set(auth(session)).send({ variant_id: (await variant(sku)).id, quantity: available });
    const blocker = await placeGuestOrder([{ sku, quantity: 1 }], { label: 'coupon-stock-blocker' });
    expect(blocker.status).toBe(201);
    try {
      const addresses = await api().get('/api/addresses').set(auth(session));
      const res = await submit({ kind: 'customerA', session, addressId: addresses.body.data.find((a) => a.is_default).id }, 'E2EONCE');
      expect([res.status, res.body.error.code]).toEqual([400, 'insufficient_stock']);
      expect(await activeUses('E2EONCE')).toBe(0);
    } finally {
      await api().post(`/api/guest-checkout/orders/${blocker.body.guest_token}/cancel`);
    }
  });
});

describe('stock and coupon contention', () => {
  it('last unit + single-use coupon + a plain buyer: one order, no partial use or hold, no 5xx (3 rounds)', async () => {
    const lastUnit = SKU.pinkBow17;
    const v = await variant(lastUnit);
    const original = v.stock_quantity;
    try {
      for (let round = 0; round < 3; round += 1) {
        await db.ProductVariant.update({ stock_quantity: 1 + (await inventoryOf(lastUnit)).reserved }, { where: { id: v.id } });
        const reservedBefore = (await inventoryOf(lastUnit)).reserved;
        const carts = [await prepareCart('customerA', lastUnit), await prepareCart('customerB', lastUnit), await prepareCart('customerC', lastUnit)];
        const results = await Promise.all([submit(carts[0], 'E2EONCE'), submit(carts[1], 'E2EONCE'), submit(carts[2], null)]);
        for (const r of results) expect(r.status).toBeLessThan(500);
        const winners = results.filter((r) => r.status === 201);
        expect(winners).toHaveLength(1);
        for (const r of results.filter((x) => x.status !== 201)) expect(['insufficient_stock', 'coupon_exhausted']).toContain(r.body.error.code);
        const couponWinners = winners.filter((r) => r.body.data.coupon_id).length;
        expect(await activeUses('E2EONCE')).toBe(couponWinners);
        expect((await inventoryOf(lastUnit)).reserved).toBe(reservedBefore + 1);
        while (placed.length) {
          const [kind, id] = placed.pop();
          expect((await api().post(`/api/orders/${id}/cancel`).set(auth(await login(kind)))).status).toBe(200);
        }
      }
    } finally {
      await db.ProductVariant.update({ stock_quantity: original }, { where: { id: v.id } });
    }
  });
});

describe('guest checkout', () => {
  it('guests cannot redeem coupons; a replayed idempotency key consumes nothing', async () => {
    const key = newIdempotencyKey();
    const extra = { coupon_code: 'E2EONCE' };
    const first = await placeGuestOrder([{ sku, quantity: 1 }], { label: 'coupon-guest', key, extra });
    const replay = await placeGuestOrder([{ sku, quantity: 1 }], { label: 'coupon-guest', key, extra });
    expect([first.status, replay.status]).toEqual([201, 200]);
    expect(first.body.data.coupon_id).toBeNull();
    expect(Number(first.body.data.discount_amount)).toBe(0);
    expect(await db.CouponUsage.count({ where: { order_id: first.body.data.id } })).toBe(0);
    expect(await activeUses('E2EONCE')).toBe(0);
    await api().post(`/api/guest-checkout/orders/${first.body.guest_token}/cancel`);
  });
});
