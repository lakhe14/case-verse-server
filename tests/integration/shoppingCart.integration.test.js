'use strict';

/**
 * Storefront shopping: the guest cart endpoint, the cart line shape (model,
 * image, available stock) and design/model search. DB-backed against
 * caseverse_e2e. Pricing assertions are campaign-aware: the Dashain window is
 * fixed, so the bundle numbers are checked only while it is open.
 */

const { getCampaign } = require('../../services/campaign.service');
const { searchTerms } = require('../../services/catalog.service');
const { api, db, login, auth, SKU, variant, inventoryOf, clearCart, placeGuestOrder } = require('./helpers');
const { skuFor } = require('../../scripts/e2e/fixtures');

afterAll(() => db.sequelize.close());

const SCARCE_LOW = skuFor('E2E Scarce stock', 'iPhone 13 mini');
const SCARCE_OUT = skuFor('E2E Scarce stock', 'iPhone 16 Pro');
const campaignOpen = () => getCampaign().active;

const guestCart = (items) => api().post('/api/guest-checkout/cart').send({ items });
const names = (res) => res.body.data.map((p) => p.name).sort();
const search = (q) => api().get('/api/products').query({ q, limit: 50 });

describe('guest cart pricing', () => {
  it('prices guest lines on the server with model, image and available stock', async () => {
    // The scarce-stock fixture is never ordered by any suite, so its stock is exact.
    const v = await variant(SCARCE_LOW);
    const res = await guestCart([{ variant_id: v.id, quantity: 1 }]);
    expect(res.status).toBe(200);
    const [line] = res.body.data.items;
    expect(line).toMatchObject({
      id: `guest-${v.id}`, variant_id: v.id, quantity: 1, unit_price: 699, compare_at_price: 999,
      line_total: 699, model: 'iPhone 13 mini', available_stock: 2, stock_ok: true, sku: SCARCE_LOW,
    });
    expect(line.product).toMatchObject({ name: 'E2E Scarce stock', slug: 'e2e-scarce-stock' });
    expect(line.product.image).toBeTruthy();
    expect(res.body.data.missing_variant_ids).toEqual([]);
  });

  it('ignores any price the browser sends and reports unknown variants', async () => {
    const v = await variant(SKU.glossyWhite);
    const res = await guestCart([{ variant_id: v.id, quantity: 1, unit_price: 1, line_total: 1 }, { variant_id: 99999999, quantity: 1 }]);
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0].unit_price).toBe(699);
    expect(res.body.data.subtotal).toBe(699);
    expect(res.body.data.missing_variant_ids).toEqual([99999999]);
  });

  it('folds duplicate lines and flags quantities above available stock', async () => {
    const v = await variant(SCARCE_LOW);
    const res = await guestCart([{ variant_id: v.id, quantity: 2 }, { variant_id: v.id, quantity: 1 }]);
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0]).toMatchObject({ quantity: 3, available_stock: 2, stock_ok: false });
    expect(res.body.data.has_stock_issue).toBe(true);
  });

  it('counts active reservations against guest cart stock', async () => {
    const before = await inventoryOf(SKU.stockProbe);
    const placed = await placeGuestOrder([{ sku: SKU.stockProbe, quantity: 1 }], { label: 'shopping-cart-hold' });
    expect(placed.status).toBe(201);
    const v = await variant(SKU.stockProbe);
    const res = await guestCart([{ variant_id: v.id, quantity: 1 }]);
    expect(res.body.data.items[0].available_stock).toBe(before.available - 1);
    expect(res.body.data.items[0].available_stock).toBe((await inventoryOf(SKU.stockProbe)).available);
    // Release the hold so later suites see the probe's usual stock.
    expect((await api().post(`/api/guest-checkout/orders/${placed.body.guest_token}/cancel`).send({})).status).toBe(200);
    expect(await inventoryOf(SKU.stockProbe)).toEqual(before);
  });

  it('rejects malformed bodies', async () => {
    expect((await guestCart([])).status).toBe(422);
    expect((await guestCart([{ variant_id: 1, quantity: 0 }])).status).toBe(422);
    expect((await guestCart([{ variant_id: 1, quantity: 21 }])).status).toBe(422);
  });

  it('applies the Dashain bundle exactly like the signed-in cart', async () => {
    const a = await variant(SKU.chetah14);
    const b = await variant(SKU.bowCherry13);
    const totals = {};
    for (const [label, items] of Object.entries({
      one: [{ variant_id: a.id, quantity: 1 }],
      two: [{ variant_id: a.id, quantity: 1 }, { variant_id: b.id, quantity: 1 }],
      three: [{ variant_id: a.id, quantity: 2 }, { variant_id: b.id, quantity: 1 }],
      four: [{ variant_id: a.id, quantity: 2 }, { variant_id: b.id, quantity: 2 }],
    })) {
      totals[label] = (await guestCart(items)).body.data;
    }
    if (campaignOpen()) {
      expect([totals.one, totals.two, totals.three, totals.four].map((c) => c.estimated_total)).toEqual([699, 1199, 1898, 2398]);
      expect([totals.one, totals.two, totals.three, totals.four].map((c) => c.bundle_pairs)).toEqual([0, 1, 1, 2]);
      expect([totals.one, totals.two].map((c) => c.coupon_allowed)).toEqual([true, false]);
      expect(totals.two.free_items[0]).toMatchObject({ type: 'suction_holder', quantity: 1 });
    } else {
      expect([totals.one, totals.two, totals.three, totals.four].map((c) => c.estimated_total)).toEqual([699, 1398, 2097, 2796]);
      expect(totals.two.coupon_allowed).toBe(true);
    }

    // Same two covers through the signed-in cart API (stock-exact fixture).
    const scarce = await variant(SCARCE_LOW);
    const guestPair = (await guestCart([{ variant_id: scarce.id, quantity: 2 }])).body.data;
    const session = await login('customerA');
    await clearCart(session);
    const added = await api().post('/api/cart/items').set(auth(session)).send({ variant_id: scarce.id, quantity: 2 });
    expect(added.status).toBe(201);
    const signedIn = added.body.data;
    expect(signedIn.estimated_total).toBe(guestPair.estimated_total);
    expect(signedIn.estimated_total).toBe(totals.two.estimated_total);
    expect(signedIn.coupon_allowed).toBe(guestPair.coupon_allowed);
    expect(signedIn.items[0]).toMatchObject({ model: 'iPhone 13 mini', available_stock: 2 });
    await clearCart(session);
  });
});

describe('storefront search', () => {
  it('splits shopper input into design and model terms', () => {
    expect(searchTerms('iPhone14 Pro  floral case')).toEqual(['iphone', '14', 'pro', 'floral']);
    expect(searchTerms('50%_off')).toEqual(['50', 'off']);
    expect(searchTerms('cover')).toEqual([]);
  });

  it('finds designs by name words', async () => {
    expect(names(await search('floral'))).toEqual(['Pink Floral']);
    expect(names(await search('bow'))).toEqual(['Bow cherry iconic', 'Pink love bow']);
    expect(names(await search('cherry case'))).toEqual(['Bow cherry iconic']);
  });

  it('finds designs by iPhone model with whole-number matching', async () => {
    expect(names(await search('iphone 15 pro'))).toEqual(['Chetah iconic', 'Pink Floral']);
    // "13" is iPhone 13 / 13 Pro Max / 13 mini, never 113 or 1.
    expect(names(await search('13'))).toEqual(['Bow cherry iconic', 'E2E Scarce stock', 'Pink love bow']);
    expect(names(await search('iphone13mini'))).toEqual(['E2E Scarce stock']);
  });

  it('requires every term on the same model', async () => {
    // Chetah comes in 14 and 15 Pro but not 14 Pro.
    expect(names(await search('chetah 14'))).toEqual(['Chetah iconic']);
    expect(names(await search('chetah 14 pro'))).toEqual([]);
    expect(names(await search('floral 17 pro'))).toEqual(['Pink Floral']);
    // Model words are whole words: "pro" is not the start of "probe".
    expect(names(await search('probe'))).toEqual(['E2E Stock probe']);
    expect(names(await search('pro 15'))).toEqual(['Chetah iconic', 'Pink Floral']);
  });

  it('treats LIKE wildcards as plain text and returns an empty list for no match', async () => {
    const wild = await search('%');
    expect(wild.status).toBe(200);
    const none = await search('zzzz');
    expect(none.status).toBe(200);
    expect(none.body.data).toEqual([]);
    expect(none.body.pagination.total).toBe(0);
  });
});

describe('public stock wording inputs', () => {
  it('exposes per-model available stock, including sold-out models', async () => {
    const res = await api().get('/api/products/e2e-scarce-stock');
    const byModel = Object.fromEntries(res.body.data.variants.map((v) => [v.attributes[0].value, v]));
    expect(byModel['iPhone 13 mini']).toMatchObject({ stock_quantity: 2, in_stock: true });
    expect(byModel['iPhone 16 Pro']).toMatchObject({ stock_quantity: 0, in_stock: false });
    const out = await variant(SCARCE_OUT);
    const add = await api().post('/api/cart/items').set(auth(await login('customerA'))).send({ variant_id: out.id, quantity: 1 });
    expect(add.status).toBe(400);
    expect(add.body.error.code).toBe('insufficient_stock');
  });
});
