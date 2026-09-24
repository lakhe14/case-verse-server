'use strict';

/**
 * Contract for the storefront: cart and checkout preview say explicitly
 * whether a coupon may be used (coupon_allowed), and it matches what order
 * placement enforces. Coupons are refused only when a Dashain pair is priced
 * into the order, never merely because the campaign window is open.
 * DB-backed against caseverse_e2e.
 */

const { api, db, login, auth, SKU, variant, clearCart } = require('./helpers');

afterAll(() => db.sequelize.close());

const KIND = 'customerD';
const CODE = 'E2EUSERONCE';

async function cartWith(lines) {
  const session = await login(KIND);
  await clearCart(session);
  for (const { sku, quantity } of lines) {
    const res = await api().post('/api/cart/items').set(auth(session)).send({ variant_id: (await variant(sku)).id, quantity });
    expect(res.status).toBe(201);
  }
  const addresses = await api().get('/api/addresses').set(auth(session));
  return { session, addressId: addresses.body.data.find((a) => a.is_default).id };
}

const preview = ({ session, addressId }, coupon) => api().post('/api/orders/preview').set(auth(session))
  .send({ shipping_address_id: addressId, parcelmoover_destination_id: 'e2e-kathmandu', ...(coupon ? { coupon_code: coupon } : {}) });

describe('coupon_allowed', () => {
  let campaignActive;
  beforeAll(async () => {
    campaignActive = (await api().get('/api/campaign/dashain')).body.data.active;
  });
  afterEach(async () => clearCart(await login(KIND)));

  it('one cover: coupons allowed whether or not the campaign window is open, and the coupon applies', async () => {
    const checkout = await cartWith([{ sku: SKU.glossyWhite, quantity: 1 }]);
    const plain = await preview(checkout);
    expect(plain.status).toBe(200);
    expect(plain.body.data).toMatchObject({ campaign_active: campaignActive, bundle_pairs: 0, coupon_allowed: true });
    const withCoupon = await preview(checkout, CODE);
    expect(withCoupon.status).toBe(200);
    expect(withCoupon.body.data.coupon).toMatchObject({ code: CODE });
    expect(withCoupon.body.data.coupon_discount).toBeGreaterThan(0);
    expect((await api().get('/api/cart').set(auth(checkout.session))).body.data.coupon_allowed).toBe(true);
  });

  it('two covers: coupons blocked exactly when the bundle is priced, and placement agrees', async () => {
    const checkout = await cartWith([{ sku: SKU.glossyWhite, quantity: 1 }, { sku: SKU.chetah14, quantity: 1 }]);
    const plain = await preview(checkout);
    expect(plain.status).toBe(200);
    expect(plain.body.data.coupon_allowed).toBe(!campaignActive);
    expect(plain.body.data.bundle_pairs).toBe(campaignActive ? 1 : 0);
    expect((await api().get('/api/cart').set(auth(checkout.session))).body.data.coupon_allowed).toBe(!campaignActive);
    const withCoupon = await preview(checkout, CODE);
    const placed = await api().post('/api/orders').set(auth(checkout.session)).send({ shipping_address_id: checkout.addressId, parcelmoover_destination_id: 'e2e-kathmandu', coupon_code: CODE });
    if (campaignActive) {
      for (const res of [withCoupon, placed]) expect([res.status, res.body.error.code]).toEqual([400, 'coupon_not_combinable_with_campaign']);
    } else {
      expect(withCoupon.status).toBe(200);
      expect(placed.status).toBe(201);
      await api().post(`/api/orders/${placed.body.data.id}/cancel`).set(auth(checkout.session));
    }
  });

  it('three and four covers keep coupons blocked while any pair is priced', async () => {
    for (const quantity of [3, 4]) {
      const checkout = await cartWith([{ sku: SKU.pinkBow12, quantity }]);
      const res = await preview(checkout);
      expect(res.body.data.coupon_allowed).toBe(!campaignActive);
      expect(res.body.data.bundle_pairs).toBe(campaignActive ? Math.floor(quantity / 2) : 0);
    }
  });
});
