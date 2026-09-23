'use strict';

const { Op } = require('sequelize');
const {
  api, db, SKU, variant, stockOf, placeGuestOrder, newIdempotencyKey, guestDetails,
} = require('./helpers');

afterAll(() => db.sequelize.close());

const ordersFor = (label) => db.Order.findAll({ where: { guest_name: `E2E ${label}` }, include: [{ model: db.OrderItem, as: 'items' }] });

async function countsFor(label) {
  const orders = await ordersFor(label);
  const ids = orders.map((o) => o.id);
  return {
    orders: orders.length,
    items: orders.reduce((n, o) => n + o.items.length, 0),
    confirmations: ids.length ? await db.OrderPaymentConfirmation.count({ where: { order_id: { [Op.in]: ids } } }) : 0,
    history: ids.length ? await db.OrderStatusHistory.count({ where: { order_id: { [Op.in]: ids } } }) : 0,
    tokens: ids.length ? await db.GuestOrderToken.count({ where: { order_id: { [Op.in]: ids } } }) : 0,
    reservations: ids.length ? await db.GuestOrderIdempotency.count({ where: { order_id: { [Op.in]: ids } } }) : 0,
  };
}

const one = { orders: 1, items: 1, confirmations: 1, history: 1, tokens: 1, reservations: 1 };

describe('guest order idempotency (DB-backed, caseverse_e2e)', () => {
  it('rejects a missing or malformed Idempotency-Key before creating anything', async () => {
    const v = await variant(SKU.pinkBow12);
    const body = { items: [{ variant_id: v.id, quantity: 1 }], guest: guestDetails('no-key') };
    const missing = await api().post('/api/guest-checkout/orders').send(body);
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('idempotency_key_required');
    const malformed = await api().post('/api/guest-checkout/orders').set('Idempotency-Key', 'x;DROP TABLE orders').send(body);
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe('invalid_idempotency_key');
    expect(JSON.stringify(malformed.body)).not.toContain('DROP TABLE');
    expect((await countsFor('no-key')).orders).toBe(0);
  });

  it('A: same key + same payload sequentially returns the same order and decrements once', async () => {
    const key = newIdempotencyKey();
    const before = await stockOf(SKU.pinkBow12);
    const first = await placeGuestOrder([{ sku: SKU.pinkBow12, quantity: 2 }], { label: 'idem-seq', key });
    const second = await placeGuestOrder([{ sku: SKU.pinkBow12, quantity: 2 }], { label: 'idem-seq', key });
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body.data.id).toBe(first.body.data.id);
    expect(second.body.data.order_number).toBe(first.body.data.order_number);
    expect(second.body.guest_token).toBe(first.body.guest_token);
    expect(await stockOf(SKU.pinkBow12)).toBe(before - 2);
    expect(await countsFor('idem-seq')).toEqual(one);
  });

  it('B: same key + same payload concurrently creates exactly one order, one decrement, one confirmation', async () => {
    const key = newIdempotencyKey();
    const sku = SKU.pinkBow12ProMax;
    const before = await stockOf(sku);
    const results = await Promise.all([
      placeGuestOrder([{ sku, quantity: 2 }], { label: 'idem-concurrent', key }),
      placeGuestOrder([{ sku, quantity: 2 }], { label: 'idem-concurrent', key }),
      placeGuestOrder([{ sku, quantity: 2 }], { label: 'idem-concurrent', key }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 201]);
    expect(new Set(results.map((r) => r.body.data.id)).size).toBe(1);
    expect(new Set(results.map((r) => r.body.guest_token)).size).toBe(1);
    expect(await stockOf(sku)).toBe(before - 2);
    expect(await countsFor('idem-concurrent')).toEqual(one);
    const order = (await ordersFor('idem-concurrent'))[0];
    expect(order.items[0].quantity).toBe(2);
  });

  it('C: same key + different payload is rejected with 409 and creates nothing new', async () => {
    const key = newIdempotencyKey();
    const first = await placeGuestOrder([{ sku: SKU.pinkBow12, quantity: 1 }], { label: 'idem-diff', key });
    expect(first.status).toBe(201);
    const stock = await stockOf(SKU.pinkBow12);
    const changed = await placeGuestOrder([{ sku: SKU.pinkBow12, quantity: 2 }], { label: 'idem-diff', key });
    expect(changed.status).toBe(409);
    expect(changed.body.error).toMatchObject({ code: 'idempotency_key_reused', message: 'This checkout request has already been used for a different order attempt.' });
    expect(JSON.stringify(changed.body)).not.toMatch(/[a-f0-9]{64}|guest_token/);
    expect(await stockOf(SKU.pinkBow12)).toBe(stock);
    expect(await countsFor('idem-diff')).toEqual(one);
  });

  it('D: a forged price-only difference is the same submission (prices are server-authoritative) and replays', async () => {
    const key = newIdempotencyKey();
    const v = await variant(SKU.pinkBow12);
    const first = await placeGuestOrder([{ sku: SKU.pinkBow12, quantity: 1 }], { label: 'idem-forged', key });
    const forged = await api().post('/api/guest-checkout/orders').set('Idempotency-Key', key).send({
      items: [{ variant_id: v.id, quantity: 1, unit_price: 1 }], guest: guestDetails('idem-forged'), total_amount: 1,
    });
    expect(forged.status).toBe(200);
    expect(forged.body.data.id).toBe(first.body.data.id);
    expect(Number(forged.body.data.total_amount)).toBe(Number(first.body.data.total_amount));
    expect(await countsFor('idem-forged')).toEqual(one);
  });

  it('E: an insufficient-stock failure leaves no reservation; the same key can be retried', async () => {
    const key = newIdempotencyKey();
    const probe = await db.ProductVariant.findOne({ where: { sku: SKU.stockProbe } });
    const stock = probe.stock_quantity;
    const tooMany = await placeGuestOrder([{ sku: SKU.stockProbe, quantity: stock + 1 }], { label: 'idem-stock', key });
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.error.code).toBe('insufficient_stock');
    expect(await db.GuestOrderIdempotency.count({ where: { key_hash: require('../../services/guestIdempotency').hashIdempotencyKey(key) } })).toBe(0);
    const again = await placeGuestOrder([{ sku: SKU.stockProbe, quantity: stock + 1 }], { label: 'idem-stock', key });
    expect(again.status).toBe(400);
    expect(await stockOf(SKU.stockProbe)).toBe(stock);
    // After the failure the same key is still usable for the same submission once it is valid.
    await probe.update({ stock_quantity: stock + 1 });
    const retried = await placeGuestOrder([{ sku: SKU.stockProbe, quantity: stock + 1 }], { label: 'idem-stock', key });
    expect(retried.status).toBe(201);
    expect(await stockOf(SKU.stockProbe)).toBe(0);
    await probe.update({ stock_quantity: stock });
    expect(await countsFor('idem-stock')).toEqual(one);
  });

  it('F: after a lost response, retrying the key recovers access to the same order', async () => {
    const key = newIdempotencyKey();
    // The first response is discarded unread, as if the network dropped it after commit.
    await placeGuestOrder([{ sku: SKU.pinkBow13ProMax, quantity: 1 }], { label: 'idem-lost', key });
    const retry = await placeGuestOrder([{ sku: SKU.pinkBow13ProMax, quantity: 1 }], { label: 'idem-lost', key });
    expect(retry.status).toBe(200);
    const lookup = await api().get(`/api/guest-checkout/orders/${retry.body.guest_token}`);
    expect(lookup.status).toBe(200);
    expect(lookup.body.data.id).toBe(retry.body.data.id);
    const record = await db.GuestOrderIdempotency.findOne({ where: { order_id: retry.body.data.id } });
    // Nothing raw at rest: only hashes and an AES-GCM sealed token.
    expect(record.key_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(record.key_hash).not.toBe(key);
    expect(record.replay_token_sealed).not.toContain(retry.body.guest_token);
    expect(await countsFor('idem-lost')).toEqual(one);
  });

  it('different keys for the same payload are separate intentional orders', async () => {
    const a = await placeGuestOrder([{ sku: SKU.pinkBow14ProMax, quantity: 1 }], { label: 'idem-two-keys' });
    const b = await placeGuestOrder([{ sku: SKU.pinkBow14ProMax, quantity: 1 }], { label: 'idem-two-keys' });
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.body.data.id).not.toBe(b.body.data.id);
  });

  it('an expired reservation is purged and the key starts a fresh order', async () => {
    const key = newIdempotencyKey();
    const first = await placeGuestOrder([{ sku: SKU.pinkBow14ProMax, quantity: 1 }], { label: 'idem-expired', key });
    await db.GuestOrderIdempotency.update({ expires_at: new Date(Date.now() - 1000) }, { where: { order_id: first.body.data.id } });
    const later = await placeGuestOrder([{ sku: SKU.pinkBow14ProMax, quantity: 1 }], { label: 'idem-expired', key });
    expect(later.status).toBe(201);
    expect(later.body.data.id).not.toBe(first.body.data.id);
    expect(await db.GuestOrderIdempotency.count({ where: { order_id: first.body.data.id } })).toBe(0);
  });
});
