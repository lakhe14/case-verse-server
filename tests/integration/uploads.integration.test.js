'use strict';

const sharp = require('sharp');
const { api, db, login, auth, SKU, placeCustomerOrder, proofFiles, PNG } = require('./helpers');

// Own file: the customer proof limiter allows 8 uploads per window per process.
afterAll(() => db.sequelize.close());

async function customerOrder() {
  const res = await placeCustomerOrder('customerA', [{ sku: SKU.pinkBow14ProMax, quantity: 1 }]);
  expect(res.status).toBe(201);
  return res.body.data;
}

const confirmationFor = (orderId) => db.OrderPaymentConfirmation.findOne({ where: { order_id: orderId } });

describe('invalid payment proof uploads', () => {
  it('rejects every malformed upload without leaving a file behind', async () => {
    const order = await customerOrder();
    const customer = await login('customerA');
    const jpeg = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#ffffff' } }).jpeg().toBuffer();
    const before = proofFiles().length;
    const cases = [
      ['pdf', Buffer.from('%PDF-1.4\n% E2E synthetic\n'), { filename: 'proof.pdf', contentType: 'application/pdf' }, 'invalid_payment_proof'],
      ['over 5 MB', Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]), { filename: 'big.png', contentType: 'image/png' }, 'payment_proof_too_large'],
      ['MIME mismatch', jpeg, { filename: 'proof.png', contentType: 'image/png' }, 'invalid_payment_proof'],
      ['corrupt PNG', Buffer.concat([PNG.subarray(0, 16), Buffer.from('corrupted-body')]), { filename: 'broken.png', contentType: 'image/png' }, 'invalid_payment_proof'],
      ['double extension script', Buffer.from('<?php echo 1; ?>'), { filename: 'proof.png.php', contentType: 'image/png' }, 'invalid_payment_proof'],
      ['empty file', Buffer.alloc(0), { filename: 'empty.png', contentType: 'image/png' }, 'invalid_payment_proof'],
    ];
    for (const [label, body, options, code] of cases) {
      const res = await api().post(`/api/orders/${order.id}/payment-proof`).set(auth(customer)).attach('proof', body, options);
      expect({ label, status: res.status, code: res.body.error?.code }).toEqual({ label, status: 400, code });
      expect(JSON.stringify(res.body)).not.toMatch(/sharp|Input buffer|stack/i);
    }
    expect(proofFiles().length).toBe(before);
    expect((await confirmationFor(order.id)).status).toBe('pending');

    // A real PNG with a misleading double extension is re-encoded and stored under a server-generated .png name.
    const disguised = await api().post(`/api/orders/${order.id}/payment-proof`).set(auth(customer)).attach('proof', PNG, { filename: 'proof.png.php', contentType: 'image/png' });
    expect(disguised.status).toBe(201);
    expect((await confirmationFor(order.id)).proof_filename).toMatch(/^\d+-[a-f0-9]{32}\.png$/);
  });
});
