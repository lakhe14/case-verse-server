'use strict';

/**
 * Public catalog cache against the real caseverse_e2e database. No Redis
 * server is available to this run, so the cache talks to an in-memory
 * stand-in (tests/support/fakeRedis) with real TTLs and a switchable
 * down/hang mode; everything else (routes, services, MySQL) is real.
 */

const cache = require('../../services/cache.service');
const FakeRedis = require('../support/fakeRedis');
const { api, db, login, auth, SKU, variant, inventoryOf, placeGuestOrder, placeCustomerOrder } = require('./helpers');

const RUN = (process.env.E2E_RUN_ID || 'run').toLowerCase();
let redis;

beforeEach(() => {
  redis = new FakeRedis();
  cache.setClientForTests(redis);
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
});
afterAll(async () => {
  cache.setClientForTests(undefined);
  await db.sequelize.close();
});

const productFor = async (sku) => db.Product.findByPk((await variant(sku)).product_id);
const detail = (slug) => api().get(`/api/products/${slug}`);
const staff = () => login('limitedStaff'); // Product Manager: manage_products
const categoryId = async () => (await productFor(SKU.glossyWhite)).category_id;

describe('cache-aside product detail', () => {
  it('second request is a cache hit with an identical body', async () => {
    const product = await productFor(SKU.glossyWhite);
    const loads = jest.spyOn(db.Product, 'findOne');
    const first = await detail(product.slug);
    const second = await detail(product.slug);
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(second.body).toEqual(first.body);
    expect(loads).toHaveBeenCalledTimes(1);
    expect(cache.getStats()).toMatchObject({ misses: 1, hits: 1 });
    // Public-safe DTO only: no reservation internals or admin stock fields.
    const cached = redis.keys(`product:slug:${product.slug}`).map((k) => redis.entry(k).value).join('');
    expect(cached).not.toMatch(/reserved_quantity|available_quantity|reservation|email|password/);
  });

  it('stock is live: a hold and its release show up at once while the metadata stays cached', async () => {
    const product = await productFor(SKU.flameSilver);
    const loads = jest.spyOn(db.Product, 'findOne');
    const stockOf = async () => (await detail(product.slug)).body.data.variants.find((v) => v.sku === SKU.flameSilver).stock_quantity;
    const before = await stockOf();
    expect(before).toBe((await inventoryOf(SKU.flameSilver)).available);
    const placed = await placeGuestOrder([{ sku: SKU.flameSilver, quantity: 2 }], { label: 'cache-stock' });
    expect(placed.status).toBe(201);
    expect(await stockOf()).toBe(before - 2);
    expect((await api().post(`/api/guest-checkout/orders/${placed.body.guest_token}/cancel`)).status).toBe(200);
    expect(await stockOf()).toBe(before);
    // Listing shows the same live figure.
    const listed = (await api().get('/api/products?limit=60')).body.data.flatMap((p) => p.variants).find((v) => v.sku === SKU.flameSilver);
    expect(listed.stock_quantity).toBe(before);
    expect(loads).toHaveBeenCalledTimes(1);
  });

  it('an admin stock edit is visible immediately', async () => {
    const product = await productFor(SKU.pinkBow17);
    const v = await variant(SKU.pinkBow17);
    const original = v.stock_quantity;
    await detail(product.slug);
    try {
      const res = await api().put(`/api/admin/products/${product.id}/variants/${v.id}`).set(auth(await staff())).send({ stock_quantity: original + 3 });
      expect(res.status).toBe(200);
      const shown = (await detail(product.slug)).body.data.variants.find((x) => x.id === v.id);
      expect(shown.stock_quantity).toBe((await inventoryOf(SKU.pinkBow17)).available);
    } finally {
      await db.ProductVariant.update({ stock_quantity: original }, { where: { id: v.id } });
    }
  });
});

describe('invalidation on catalog writes', () => {
  it('a rename (which also re-slugs) and an image change are visible on the very next request', async () => {
    const product = await productFor(SKU.glossyWhite);
    const { name, slug } = product;
    const manager = await staff();
    expect((await detail(slug)).body.data.name).toBe(name); // cached
    let newSlug;
    try {
      const renamed = await api().put(`/api/admin/products/${product.id}`).set(auth(manager)).send({ name: `${name} renamed` });
      expect(renamed.status).toBe(200);
      newSlug = renamed.body.data.slug;
      expect(newSlug).not.toBe(slug);
      expect((await detail(slug)).status).toBe(404); // the cached old slug is gone at once
      expect((await detail(newSlug)).body.data.name).toBe(`${name} renamed`);
    } finally {
      await api().put(`/api/admin/products/${product.id}`).set(auth(manager)).send({ name });
    }
    expect((await detail(slug)).body.data.name).toBe(name);
    expect((await detail(newSlug)).status).toBe(404);

    // Removing an image is a catalog write too (the image is seeded directly:
    // uploads need real files, which this test does not create).
    const image = await db.ProductImage.create({ product_id: product.id, variant_id: null, url: '/assets/caseverse/Glossy_black.png', sort_order: 9 });
    await cache.invalidateCatalog();
    expect((await detail(slug)).body.data.images.map((i) => i.id)).toContain(image.id);
    expect((await api().delete(`/api/admin/products/${product.id}/images/${image.id}`).set(auth(manager))).status).toBe(204);
    expect((await detail(slug)).body.data.images.map((i) => i.id)).not.toContain(image.id);
  });

  it('negative cache: an unknown slug is looked up once, then a created product appears immediately; deletion removes it', async () => {
    const name = `E2E cache ghost ${RUN}`;
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const loads = jest.spyOn(db.Product, 'findOne');
    const misses = [await detail(slug), await detail(slug)];
    for (const res of misses) expect([res.status, res.body.error.code]).toEqual([404, 'product_not_found']);
    expect(misses[1].body.error.message).toBe(misses[0].body.error.message);
    expect(loads).toHaveBeenCalledTimes(1);
    expect(cache.getStats().negative_hits).toBe(1);

    const manager = await staff();
    const created = await api().post('/api/admin/products').set(auth(manager)).send({ category_id: await categoryId(), name, base_price: 699, status: 'active', variants: [{ sku: `E2E-CACHE-${RUN}`.toUpperCase().slice(0, 64), price: 699, stock_quantity: 2 }] });
    expect(created.status).toBe(201);
    expect(created.body.data.slug).toBe(slug);
    try {
      const found = await detail(slug);
      expect(found.status).toBe(200);
      expect(found.body.data.variants[0].stock_quantity).toBe(2);
    } finally {
      expect((await api().delete(`/api/admin/products/${created.body.data.id}`).set(auth(manager))).status).toBe(204);
    }
    expect((await detail(slug)).status).toBe(404);
  });

  it('lists and categories: cached, then a new or deactivated product changes the next list', async () => {
    const loads = jest.spyOn(db.Product, 'findAndCountAll');
    const categoryLoads = jest.spyOn(db.Category, 'findAll');
    const slugs = async () => (await api().get('/api/products?limit=60')).body.data.map((p) => p.slug);
    const initial = await slugs();
    expect(await slugs()).toEqual(initial);
    expect(loads).toHaveBeenCalledTimes(1);
    const categories = [await api().get('/api/categories'), await api().get('/api/categories')];
    expect(categories[1].body).toEqual(categories[0].body);
    expect(categoryLoads).toHaveBeenCalledTimes(1);

    const manager = await staff();
    const name = `E2E cache list ${RUN}`;
    const created = await api().post('/api/admin/products').set(auth(manager)).send({ category_id: await categoryId(), name, base_price: 699, status: 'active', variants: [{ sku: `E2E-CACHE-L-${RUN}`.toUpperCase().slice(0, 64), price: 699, stock_quantity: 1 }] });
    expect(created.status).toBe(201);
    try {
      expect(await slugs()).toContain(created.body.data.slug);
      expect((await api().put(`/api/admin/products/${created.body.data.id}`).set(auth(manager)).send({ status: 'inactive' })).status).toBe(200);
      expect(await slugs()).not.toContain(created.body.data.slug);
      expect((await detail(created.body.data.slug)).status).toBe(404);
    } finally {
      await api().delete(`/api/admin/products/${created.body.data.id}`).set(auth(manager));
    }
    expect(await slugs()).toEqual(initial);
  });
});

describe('abuse and key cardinality', () => {
  it('malformed slugs and long searches still answer correctly but never create cache keys', async () => {
    for (const slug of ['Not_A_Slug', 'UPPER', 'trailing-', 'a--b']) {
      expect((await detail(slug)).status).toBe(404);
    }
    expect((await api().get(`/api/products?q=${'x'.repeat(60)}`)).status).toBe(200);
    expect((await api().get('/api/products?page=25')).status).toBe(200);
    expect(redis.keys()).toEqual([]);
    expect(cache.getStats().bypassed).toBe(6);
    expect(redis.keys('products:list').length).toBe(0);
  });

  it('equivalent list queries share one key (search is normalised)', async () => {
    await api().get('/api/products?q=Glossy&limit=20');
    await api().get('/api/products?q=%20glossy%20&limit=20');
    expect(redis.keys('products:list').length).toBe(1);
    expect(cache.getStats().hits).toBe(1);
  });
});

describe('transactional paths never touch the cache', () => {
  it('cart, checkout preview and order placement make no Redis calls', async () => {
    const customer = await login('customerA');
    const addresses = await api().get('/api/addresses').set(auth(customer));
    const before = { ...redis.calls };
    await api().delete('/api/cart').set(auth(customer));
    await api().post('/api/cart/items').set(auth(customer)).send({ variant_id: (await variant(SKU.chetah14)).id, quantity: 1 });
    await api().get('/api/cart').set(auth(customer));
    const preview = await api().post('/api/orders/preview').set(auth(customer)).send({ shipping_address_id: addresses.body.data.find((a) => a.is_default).id, parcelmoover_destination_id: 'e2e-kathmandu' });
    expect(preview.status).toBe(200);
    const placed = await placeCustomerOrder('customerA', [{ sku: SKU.chetah14, quantity: 1 }]);
    expect(placed.status).toBe(201);
    await api().post(`/api/orders/${placed.body.data.id}/cancel`).set(auth(customer));
    expect(redis.calls.get).toBe(before.get);
    expect(redis.calls.set).toBe(before.set);
    // Product responses carry no campaign-dependent fields: Dashain pricing is
    // computed live at cart/checkout, so no cached value can straddle a boundary.
    const product = (await detail((await productFor(SKU.chetah14)).slug)).body.data;
    expect(Object.keys(product).filter((k) => /campaign|bundle/.test(k))).toEqual([]);
  });
});

describe('Redis unavailable', () => {
  it.each(['down', 'hang'])('%s: catalog, checkout and admin writes all keep working from MySQL', async (mode) => {
    const product = await productFor(SKU.glossyWhite);
    await detail(product.slug); // warm
    redis.mode = mode;
    const started = Date.now();
    const res = await detail(product.slug);
    expect(res.status).toBe(200);
    expect(res.body.data.slug).toBe(product.slug);
    expect((await api().get('/api/products?limit=60')).status).toBe(200);
    expect((await api().get('/api/categories')).status).toBe(200);
    const placed = await placeCustomerOrder('customerB', [{ sku: SKU.glossyWhite, quantity: 1 }]);
    expect(placed.status).toBe(201);
    await api().post(`/api/orders/${placed.body.data.id}/cancel`).set(auth(await login('customerB')));
    const write = await api().put(`/api/admin/products/${product.id}`).set(auth(await staff())).send({ name: product.name });
    expect(write.status).toBe(200);
    const health = await api().get('/api/health');
    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({ status: 'degraded', database: 'ok', cache: 'degraded' });
    expect(JSON.stringify([res.body, health.body])).not.toMatch(/ECONNREFUSED|redis|6379|timed out/i);
    expect(Date.now() - started).toBeLessThan(mode === 'hang' ? 8000 : 4000);

    // Back up: the missed invalidation is retried first; nothing stale is served.
    redis.mode = 'up';
    expect((await detail(product.slug)).status).toBe(200);
    expect((await api().get('/api/health')).body).toMatchObject({ status: 'ok', cache: 'ok' });
  });

  it('health reports a healthy cache without any URL or credentials', async () => {
    const res = await api().get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', database: 'ok', cache: 'ok' });
    expect(Object.keys(res.body).sort()).toEqual(['cache', 'database', 'status', 'time']);
  });
});
