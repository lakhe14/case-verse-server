'use strict';

const { api, db, login, auth, SKU, variant, stockOf, clearCart } = require('./helpers');

afterAll(() => db.sequelize.close());

describe('duplicate order submission', () => {
  it('two simultaneous placements of one cart create exactly one order and one stock decrement', async () => {
    const customer = await login('customerB');
    await clearCart(customer);
    const sku = SKU.pinkBow12;
    const before = await stockOf(sku);
    const added = await api().post('/api/cart/items').set(auth(customer)).send({ variant_id: (await variant(sku)).id, quantity: 1 });
    expect(added.status).toBe(201);
    const addresses = await api().get('/api/addresses').set(auth(customer));
    const body = { shipping_address_id: addresses.body.data.find((a) => a.is_default).id, parcelmoover_destination_id: 'e2e-kathmandu' };
    const ordersBefore = await db.Order.count({ where: { user_id: customer.profile.id } });

    const results = await Promise.all([
      api().post('/api/orders').set(auth(customer)).send(body),
      api().post('/api/orders').set(auth(customer)).send(body),
    ]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 400]);
    expect(results.find((r) => r.status === 400).body.error.code).toBe('cart_empty');
    expect(await db.Order.count({ where: { user_id: customer.profile.id } })).toBe(ordersBefore + 1);
    expect(await stockOf(sku)).toBe(before - 1);
  });
});
