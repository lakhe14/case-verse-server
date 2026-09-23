'use strict';

const fs = require('fs');
const path = require('path');
const {
  api, db, env, login, auth, SKU, placeCustomerOrder, placeGuestOrder, proofFiles, PNG,
} = require('./helpers');

afterAll(() => db.sequelize.close());

const REAL_PROOF_DIR = path.resolve(__dirname, '..', '..', 'private-uploads', 'payment-proofs');
const realProofCount = () => (fs.existsSync(REAL_PROOF_DIR) ? fs.readdirSync(REAL_PROOF_DIR).length : 0);

async function customerOrder(kind = 'customerA') {
  const res = await placeCustomerOrder(kind, [{ sku: SKU.pinkBow12ProMax, quantity: 1 }]);
  expect(res.status).toBe(201);
  return res.body.data;
}

const confirmationFor = (orderId) => db.OrderPaymentConfirmation.findOne({ where: { order_id: orderId } });

describe('real payment proof lifecycle', () => {
  it('stores a valid proof only in the E2E directory and lets only payment staff view it', async () => {
    const realBefore = realProofCount();
    const order = await customerOrder();
    const customer = await login('customerA');
    const upload = await api().post(`/api/orders/${order.id}/payment-proof`).set(auth(customer))
      .attach('proof', PNG, { filename: 'e2e-proof.png', contentType: 'image/png' });
    expect(upload.status).toBe(201);
    expect(upload.body.data.status).toBe('proof_uploaded');

    const confirmation = await confirmationFor(order.id);
    expect(confirmation.proof_filename).toMatch(/^\d+-[a-f0-9]{32}\.png$/);
    expect(fs.existsSync(path.join(env.uploads.proofDir, confirmation.proof_filename))).toBe(true);
    expect(path.relative(path.resolve(__dirname, '..', '..', '.tmp'), env.uploads.proofDir)).not.toMatch(/^\.\./);
    expect(realProofCount()).toBe(realBefore);

    const staff = await login('staff');
    const proof = await api().get(`/api/admin/payment-confirmations/${confirmation.id}/proof`).set(auth(staff));
    expect(proof.status).toBe(200);
    expect(proof.headers['content-type']).toMatch(/image\/png/);
    expect(proof.headers['cache-control']).toMatch(/no-store/);

    expect((await api().get(`/api/admin/payment-confirmations/${confirmation.id}/proof`)).status).toBe(401);
    expect((await api().get(`/api/admin/payment-confirmations/${confirmation.id}/proof`).set(auth(customer))).status).toBe(403);
    expect((await api().get(`/api/admin/payment-confirmations/${confirmation.id}/proof`).set(auth(await login('customerB')))).status).toBe(403);
    expect((await api().get(`/api/admin/payment-confirmations/${confirmation.id}/proof`).set(auth(await login('limitedStaff')))).status).toBe(403);
  });

  it('approves proof_uploaded -> approved, advances the order, and refuses a second review', async () => {
    const order = await customerOrder();
    const customer = await login('customerA');
    await api().post(`/api/orders/${order.id}/payment-proof`).set(auth(customer)).attach('proof', PNG, { filename: 'p.png', contentType: 'image/png' });
    const confirmation = await confirmationFor(order.id);
    const staff = await login('staff');

    const queue = await api().get('/api/admin/payment-confirmations').set(auth(staff));
    expect(queue.status).toBe(200);
    expect(queue.body.data.map((row) => row.id)).toContain(confirmation.id);

    const approve = await api().post(`/api/admin/payment-confirmations/${confirmation.id}/approve`).set(auth(staff)).send({ note: 'E2E approve' });
    expect(approve.status).toBe(200);
    expect((await confirmationFor(order.id)).status).toBe('approved');
    expect((await db.Order.findByPk(order.id)).status).toBe('processing');
    const history = await db.OrderStatusHistory.findAll({ where: { order_id: order.id }, order: [['id', 'ASC']] });
    expect(history.map((h) => h.status)).toEqual(['pending', 'processing']);

    const again = await api().post(`/api/admin/payment-confirmations/${confirmation.id}/approve`).set(auth(staff)).send({});
    // The order is now processing, so it has left the review scope: a second review is refused.
    expect(again.status).toBe(404);
    expect((await confirmationFor(order.id)).status).toBe('approved');
    const customerView = await api().get(`/api/orders/${order.id}`).set(auth(customer));
    expect(customerView.body.data.paymentConfirmation.status).toBe('approved');
    expect(customerView.body.data.paymentConfirmation).not.toHaveProperty('proof_path');
  });

  it('rejects proof_uploaded -> rejected with a bounded note and lets the customer re-upload', async () => {
    const order = await customerOrder();
    const customer = await login('customerA');
    await api().post(`/api/orders/${order.id}/payment-proof`).set(auth(customer)).attach('proof', PNG, { filename: 'p.png', contentType: 'image/png' });
    const confirmation = await confirmationFor(order.id);
    const staff = await login('staff');

    const tooLong = await api().post(`/api/admin/payment-confirmations/${confirmation.id}/reject`).set(auth(staff)).send({ note: 'x'.repeat(501) });
    expect(tooLong.status).toBe(422);
    const reject = await api().post(`/api/admin/payment-confirmations/${confirmation.id}/reject`).set(auth(staff)).send({ note: 'E2E: screenshot unreadable' });
    expect(reject.status).toBe(200);
    const updated = await confirmationFor(order.id);
    expect(updated.status).toBe('rejected');
    expect(updated.admin_note).toBe('E2E: screenshot unreadable');
    expect((await db.Order.findByPk(order.id)).status).toBe('pending');
    expect(await db.OrderStatusHistory.count({ where: { order_id: order.id } })).toBe(1);

    const customerView = await api().get(`/api/orders/${order.id}`).set(auth(customer));
    expect(customerView.body.data.paymentConfirmation).toMatchObject({ status: 'rejected', admin_note: 'E2E: screenshot unreadable' });
    const reupload = await api().post(`/api/orders/${order.id}/payment-proof`).set(auth(customer)).attach('proof', PNG, { filename: 'p2.png', contentType: 'image/png' });
    expect(reupload.status).toBe(201);
    expect((await confirmationFor(order.id)).status).toBe('proof_uploaded');
  });
});

describe('customer ownership isolation', () => {
  it('customer B cannot read, cancel, upload to, or request COD on customer A\'s order', async () => {
    const order = await customerOrder('customerA');
    const b = await login('customerB');
    const before = proofFiles().length;
    expect((await api().get(`/api/orders/${order.id}`).set(auth(b))).status).toBe(404);
    expect((await api().post(`/api/orders/${order.id}/cancel`).set(auth(b))).status).toBe(404);
    const upload = await api().post(`/api/orders/${order.id}/payment-proof`).set(auth(b)).attach('proof', PNG, { filename: 'b.png', contentType: 'image/png' });
    expect(upload.status).toBe(404);
    expect((await api().post(`/api/orders/${order.id}/payment-method/cod`).set(auth(b))).status).toBe(404);
    expect(proofFiles().length).toBe(before);
    const list = await api().get('/api/orders').set(auth(b));
    expect(list.body.data.map((o) => o.id)).not.toContain(order.id);
    const fresh = await db.Order.findByPk(order.id);
    expect(fresh.status).toBe('pending');
    expect((await confirmationFor(order.id)).status).toBe('pending');
  });
});

describe('guest token access and isolation', () => {
  it('each guest token opens only its own order; random and malformed tokens fail', async () => {
    const a = await placeGuestOrder([{ sku: SKU.pinkBow13ProMax, quantity: 1 }], { label: 'token-a' });
    const b = await placeGuestOrder([{ sku: SKU.pinkBow13ProMax, quantity: 1 }], { label: 'token-b' });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.guest_token).not.toBe(b.body.guest_token);
    // Only the hash is stored.
    expect(await db.GuestOrderToken.count({ where: { token_hash: a.body.guest_token } })).toBe(0);

    const readA = await api().get(`/api/guest-checkout/orders/${a.body.guest_token}`);
    expect(readA.status).toBe(200);
    expect(readA.body.data.id).toBe(a.body.data.id);
    expect(readA.body.data.id).not.toBe(b.body.data.id);

    await api().post(`/api/guest-checkout/orders/${a.body.guest_token}/payment-proof`).attach('proof', PNG, { filename: 'a.png', contentType: 'image/png' });
    expect((await confirmationFor(a.body.data.id)).status).toBe('proof_uploaded');
    expect((await confirmationFor(b.body.data.id)).status).toBe('pending');

    const random = 'E2Erandom'.padEnd(43, 'x');
    expect((await api().get(`/api/guest-checkout/orders/${random}`)).status).toBe(404);
    expect((await api().post(`/api/guest-checkout/orders/${random}/cancel`)).status).toBe(404);
    expect((await api().get('/api/guest-checkout/orders/short')).status).toBe(422);
    // A customer token is not a guest token, and a guest order is not a customer order.
    const customer = await login('customerA');
    expect((await api().get(`/api/orders/${a.body.data.id}`).set(auth(customer))).status).toBe(404);
  });
});

describe('COD request and confirmation', () => {
  it('pending -> cod_pending on request; only payment staff confirm -> cod_confirmed', async () => {
    const placed = await placeGuestOrder([{ sku: SKU.pinkBow13ProMax, quantity: 1 }], { label: 'cod' });
    const token = placed.body.guest_token;
    const orderId = placed.body.data.id;
    const cod = await api().post(`/api/guest-checkout/orders/${token}/payment-method/cod`);
    expect(cod.status).toBe(200);
    const pending = await confirmationFor(orderId);
    expect(pending).toMatchObject({ method: 'whatsapp_cod', status: 'cod_pending' });
    expect((await db.Order.findByPk(orderId)).status).toBe('pending');

    const staff = await login('staff');
    const limited = await login('limitedStaff');
    expect((await api().post(`/api/admin/payment-confirmations/${pending.id}/approve`).set(auth(limited)).send({})).status).toBe(403);
    expect((await api().put(`/api/admin/orders/${orderId}/status`).set(auth(staff)).send({ status: 'processing' })).status).toBe(403);
    const rejectCod = await api().post(`/api/admin/payment-confirmations/${pending.id}/reject`).set(auth(staff)).send({});
    expect(rejectCod.status).toBe(400);
    expect(rejectCod.body.error.code).toBe('invalid_payment_review');

    const confirm = await api().post(`/api/admin/payment-confirmations/${pending.id}/approve`).set(auth(staff)).send({});
    expect(confirm.status).toBe(200);
    expect((await confirmationFor(orderId)).status).toBe('cod_confirmed');
    expect((await db.Order.findByPk(orderId)).status).toBe('processing');
    // Confirmed COD orders can no longer be cancelled by the guest or re-requested.
    expect((await api().post(`/api/guest-checkout/orders/${token}/cancel`)).status).toBe(400);
    expect((await api().post(`/api/guest-checkout/orders/${token}/payment-method/cod`)).status).toBe(400);
  });

  it('a cancelled order cannot be reviewed', async () => {
    const order = await customerOrder();
    const customer = await login('customerA');
    await api().post(`/api/orders/${order.id}/payment-method/cod`).set(auth(customer));
    await api().post(`/api/orders/${order.id}/cancel`).set(auth(customer));
    const confirmation = await confirmationFor(order.id);
    expect(confirmation.status).toBe('cod_pending');
    const res = await api().post(`/api/admin/payment-confirmations/${confirmation.id}/approve`).set(auth(await login('staff'))).send({});
    // Cancelled orders drop out of the review scope entirely.
    expect(res.status).toBe(404);
    expect((await confirmationFor(order.id)).status).toBe('cod_pending');
    expect((await db.Order.findByPk(order.id)).status).toBe('cancelled');
  });
});

describe('limited staff denial (direct API)', () => {
  it('returns 403 for queue, proof, approve and reject on a real confirmation', async () => {
    const order = await customerOrder();
    const customer = await login('customerA');
    await api().post(`/api/orders/${order.id}/payment-proof`).set(auth(customer)).attach('proof', PNG, { filename: 'p.png', contentType: 'image/png' });
    const confirmation = await confirmationFor(order.id);
    const limited = await login('limitedStaff');
    expect(limited.profile.permissions).not.toContain('manage_order_payments');
    expect((await api().get('/api/admin/payment-confirmations').set(auth(limited))).status).toBe(403);
    expect((await api().get(`/api/admin/payment-confirmations/${confirmation.id}/proof`).set(auth(limited))).status).toBe(403);
    expect((await api().post(`/api/admin/payment-confirmations/${confirmation.id}/approve`).set(auth(limited)).send({})).status).toBe(403);
    expect((await api().post(`/api/admin/payment-confirmations/${confirmation.id}/reject`).set(auth(limited)).send({})).status).toBe(403);
    expect((await confirmationFor(order.id)).status).toBe('proof_uploaded');
  });
});
