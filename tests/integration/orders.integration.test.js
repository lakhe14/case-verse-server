'use strict';

const {
  api, db, login, auth, SKU, variant, stockOf, clearCart, placeCustomerOrder, placeGuestOrder,
} = require('./helpers');

afterAll(() => db.sequelize.close());

describe('stock arithmetic (DB-backed)', () => {
  it('rejects the same guest variant submitted twice when the aggregate exceeds stock', async () => {
    expect(await stockOf(SKU.stockProbe)).toBe(6);
    const res = await placeGuestOrder([{ sku: SKU.stockProbe, quantity: 4 }, { sku: SKU.stockProbe, quantity: 4 }], { label: 'duplicate-lines' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('insufficient_stock');
    expect(await stockOf(SKU.stockProbe)).toBe(6);
    expect(await db.Order.count({ where: { guest_name: 'E2E duplicate-lines' } })).toBe(0);
  });

  it('rejects a customer cart whose repeated adds exceed stock', async () => {
    const customer = await login('customerA');
    await clearCart(customer);
    const variantId = (await variant(SKU.stockProbe)).id;
    const first = await api().post('/api/cart/items').set(auth(customer)).send({ variant_id: variantId, quantity: 4 });
    expect(first.status).toBe(201);
    const second = await api().post('/api/cart/items').set(auth(customer)).send({ variant_id: variantId, quantity: 4 });
    expect(second.status).toBe(400);
    expect(second.body.error.code).toBe('insufficient_stock');
    expect(first.body.data.items.find((i) => i.variant_id === variantId).quantity).toBe(4);
    await clearCart(customer);
  });

  it('decrements on order, restocks exactly once on cancel, and refuses a second cancel', async () => {
    const before = await stockOf(SKU.stockProbe);
    const placed = await placeCustomerOrder('customerA', [{ sku: SKU.stockProbe, quantity: 2 }]);
    expect(placed.status).toBe(201);
    expect(await stockOf(SKU.stockProbe)).toBe(before - 2);

    const customer = await login('customerA');
    const cancel = await api().post(`/api/orders/${placed.body.data.id}/cancel`).set(auth(customer));
    expect(cancel.status).toBe(200);
    expect(cancel.body.data.status).toBe('cancelled');
    expect(await stockOf(SKU.stockProbe)).toBe(before);

    const again = await api().post(`/api/orders/${placed.body.data.id}/cancel`).set(auth(customer));
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('order_not_cancellable');
    // A staff "cancel" on an already-cancelled order is a no-op, not a second restock.
    const staff = await login('staff');
    const staffCancel = await api().put(`/api/admin/orders/${placed.body.data.id}/status`).set(auth(staff)).send({ status: 'cancelled' });
    expect(staffCancel.status).toBe(200);
    expect(await stockOf(SKU.stockProbe)).toBe(before);
    const history = await db.OrderStatusHistory.count({ where: { order_id: placed.body.data.id, status: 'cancelled' } });
    expect(history).toBe(1);
  });

  it('guest cancellation restores stock once', async () => {
    const before = await stockOf(SKU.flameSilver);
    const placed = await placeGuestOrder([{ sku: SKU.flameSilver, quantity: 1 }], { label: 'guest-cancel' });
    expect(placed.status).toBe(201);
    expect(await stockOf(SKU.flameSilver)).toBe(before - 1);
    const token = placed.body.guest_token;
    expect((await api().post(`/api/guest-checkout/orders/${token}/cancel`)).status).toBe(200);
    expect((await api().post(`/api/guest-checkout/orders/${token}/cancel`)).status).toBe(400);
    expect(await stockOf(SKU.flameSilver)).toBe(before);
  });
});

describe('server-authoritative pricing', () => {
  it('ignores forged customer totals and persists the computed amounts', async () => {
    const customer = await login('customerA');
    await clearCart(customer);
    const v = await variant(SKU.pinkBow12);
    await api().post('/api/cart/items').set(auth(customer)).send({ variant_id: v.id, quantity: 1 });
    const addresses = await api().get('/api/addresses').set(auth(customer));
    const addressId = addresses.body.data.find((a) => a.is_default).id;
    const preview = await api().post('/api/orders/preview').set(auth(customer)).send({ shipping_address_id: addressId, parcelmoover_destination_id: 'e2e-kathmandu' });
    expect(preview.status).toBe(200);

    const forged = await api().post('/api/orders').set(auth(customer)).send({
      shipping_address_id: addressId,
      parcelmoover_destination_id: 'e2e-kathmandu',
      price: 1, unit_price: 1, subtotal_amount: 1, shipping_amount: 0, total_amount: 1, total: 1, discount_amount: 698,
      items: [{ variant_id: v.id, quantity: 1, unit_price: 1 }],
    });
    expect(forged.status).toBe(201);
    const order = await db.Order.findByPk(forged.body.data.id, { include: [{ model: db.OrderItem, as: 'items' }] });
    expect(Number(order.subtotal_amount)).toBe(699);
    expect(Number(order.shipping_amount)).toBe(preview.body.data.shipping_amount);
    expect(Number(order.shipping_amount)).toBeGreaterThan(0);
    expect(Number(order.total_amount)).toBe(preview.body.data.total_amount);
    expect(Number(order.discount_amount)).toBe(0);
    expect(order.items.map((i) => Number(i.unit_price))).toEqual([699]);
  });

  it('ignores forged guest totals and line prices', async () => {
    const v = await variant(SKU.pinkBow12);
    const preview = await api().post('/api/guest-checkout/preview').send({
      items: [{ variant_id: v.id, quantity: 1 }],
      guest: { municipality: 'Kathmandu', province: 'Bagmati', parcelmoover_destination_id: 'e2e-kathmandu' },
    });
    expect(preview.status).toBe(200);
    const forged = await placeGuestOrder([{ sku: SKU.pinkBow12, quantity: 1 }], {
      label: 'price-tamper',
      extra: { total_amount: 1, shipping_amount: 0, subtotal: 1 },
    });
    expect(forged.status).toBe(201);
    // Also forge per-line prices directly.
    const lineForged = await api().post('/api/guest-checkout/orders').set('Idempotency-Key', require('./helpers').newIdempotencyKey()).send({
      items: [{ variant_id: v.id, quantity: 1, unit_price: 1, line_total: 1, price: 1 }],
      guest: { ...require('./helpers').guestDetails('line-tamper'), shipping_amount: 0 },
      total_amount: 1,
    });
    expect({ status: lineForged.status, code: lineForged.body.error?.code }).toEqual({ status: 201, code: undefined });
    for (const id of [forged.body.data.id, lineForged.body.data.id]) {
      const order = await db.Order.findByPk(id, { include: [{ model: db.OrderItem, as: 'items' }] });
      expect(Number(order.subtotal_amount)).toBe(699);
      expect(Number(order.total_amount)).toBe(preview.body.data.total_amount);
      expect(Number(order.shipping_amount)).toBe(preview.body.data.shipping_amount);
      expect(Number(order.items[0].unit_price)).toBe(699);
    }
  });
});

describe('payment workflow lock', () => {
  it('blocks processing before approval and allows fulfilment after it', async () => {
    const placed = await placeCustomerOrder('customerA', [{ sku: SKU.pinkBow12, quantity: 1 }]);
    expect(placed.status).toBe(201);
    const orderId = placed.body.data.id;
    const staff = await login('staff');

    const early = await api().put(`/api/admin/orders/${orderId}/status`).set(auth(staff)).send({ status: 'processing' });
    expect(early.status).toBe(403);
    expect(early.body.error.code).toBe('payment_confirmation_required');
    const earlyShip = await api().put(`/api/admin/orders/${orderId}/status`).set(auth(staff)).send({ status: 'shipped' });
    expect(earlyShip.status).toBe(403);

    const customer = await login('customerA');
    const { PNG } = require('./helpers');
    const upload = await api().post(`/api/orders/${orderId}/payment-proof`).set(auth(customer)).attach('proof', PNG, { filename: 'e2e-proof.png', contentType: 'image/png' });
    expect(upload.status).toBe(201);
    const stillBlocked = await api().put(`/api/admin/orders/${orderId}/status`).set(auth(staff)).send({ status: 'processing' });
    expect(stillBlocked.status).toBe(403);

    const confirmation = await db.OrderPaymentConfirmation.findOne({ where: { order_id: orderId } });
    const approve = await api().post(`/api/admin/payment-confirmations/${confirmation.id}/approve`).set(auth(staff)).send({});
    expect(approve.status).toBe(200);
    expect((await db.Order.findByPk(orderId)).status).toBe('processing');

    const ship = await api().put(`/api/admin/orders/${orderId}/status`).set(auth(staff)).send({ status: 'shipped' });
    expect(ship.status).toBe(200);
    expect(ship.body.data.status).toBe('shipped');
    // A fulfilled order can no longer be cancelled by the customer.
    const cancel = await api().post(`/api/orders/${orderId}/cancel`).set(auth(customer));
    expect(cancel.status).toBe(400);
  });
});
