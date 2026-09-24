'use strict';

/**
 * Catalog deletes with order history and catalog-import stock floors.
 * DB-backed against caseverse_e2e.
 */

const inventory = require('../../services/inventory.service');
const { api, db, login, auth, SKU, variant, inventoryOf, placeGuestOrder } = require('./helpers');

afterAll(() => db.sequelize.close());

const LEAK = /Sequelize|ER_[A-Z_]+|FOREIGN KEY|CONSTRAINT|order_items|inventory_reservations|product_variants|SELECT|DELETE FROM/i;

async function hold(sku, quantity, label) {
  const placed = await placeGuestOrder([{ sku, quantity }], { label });
  expect(placed.status).toBe(201);
  return placed.body.guest_token;
}
const release = (token) => api().post(`/api/guest-checkout/orders/${token}/cancel`);

describe('deleting catalog items with order history', () => {
  let token;
  let v;
  beforeAll(async () => {
    token = await hold(SKU.glossyWhite, 1, 'catalog-delete');
    v = await variant(SKU.glossyWhite);
  });
  afterAll(() => release(token));

  it('a referenced product is refused with 409 product_in_use and nothing is deleted', async () => {
    const res = await api().delete(`/api/admin/products/${v.product_id}`).set(auth(await login('limitedStaff')));
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'product_in_use',
      message: 'This product cannot be deleted because it is referenced by existing orders. Deactivate it instead.',
    });
    expect(JSON.stringify(res.body)).not.toMatch(LEAK);
    expect(await db.Product.findByPk(v.product_id)).not.toBeNull();
    expect(await variant(SKU.glossyWhite)).not.toBeNull();
  });

  it('a referenced variant is refused with 409 variant_in_use, still after the order is cancelled', async () => {
    const staff = await login('limitedStaff');
    let res = await api().delete(`/api/admin/products/${v.product_id}/variants/${v.id}`).set(auth(staff));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('variant_in_use');
    expect(JSON.stringify(res.body)).not.toMatch(LEAK);
    await release(token);
    // Order lines are history: a cancelled order still references the variant.
    res = await api().delete(`/api/admin/products/${v.product_id}/variants/${v.id}`).set(auth(staff));
    expect(res.status).toBe(409);
    expect(await variant(SKU.glossyWhite)).not.toBeNull();
  });

  it('only staff with manage_products may attempt a delete', async () => {
    const url = `/api/admin/products/${v.product_id}`;
    expect((await api().delete(url)).status).toBe(401);
    expect((await api().delete(url).set(auth(await login('customerA')))).status).toBe(403);
    const orderManager = await api().delete(url).set(auth(await login('staff')));
    expect(orderManager.status).toBe(403);
    expect(orderManager.body.error.code).toBe('missing_permission');
    expect((await api().delete(url).set(auth(await login('limitedStaff')))).status).toBe(409);
  });

  it('a variant id is only deletable through its own product', async () => {
    const other = await variant(SKU.chetah14);
    const res = await api().delete(`/api/admin/products/${other.product_id}/variants/${v.id}`).set(auth(await login('limitedStaff')));
    expect(res.status).toBe(404);
  });
});

describe('deleting unreferenced catalog items', () => {
  it('an unused variant and an unused product are deleted', async () => {
    const staff = await login('limitedStaff');
    const categoryId = (await db.Product.findByPk((await variant(SKU.glossyWhite)).product_id)).category_id;
    const created = await api().post('/api/admin/products').set(auth(staff)).send({
      category_id: categoryId,
      name: `E2E delete probe ${process.env.E2E_RUN_ID}`,
      base_price: 699,
      status: 'draft',
      variants: [
        { sku: `E2E-DEL-A-${process.env.E2E_RUN_ID}`.slice(0, 64), price: 699, stock_quantity: 1 },
        { sku: `E2E-DEL-B-${process.env.E2E_RUN_ID}`.slice(0, 64), price: 699, stock_quantity: 1 },
      ],
    });
    expect(created.status).toBe(201);
    const product = created.body.data;
    const res = await api().delete(`/api/admin/products/${product.id}/variants/${product.variants[0].id}`).set(auth(staff));
    expect(res.status).toBe(204);
    expect(await db.ProductVariant.findByPk(product.variants[0].id)).toBeNull();
    expect((await api().delete(`/api/admin/products/${product.id}`).set(auth(staff))).status).toBe(204);
    expect(await db.Product.findByPk(product.id)).toBeNull();
    expect(await db.ProductVariant.findByPk(product.variants[1].id)).toBeNull();
  });
});

describe('catalog import stock floor', () => {
  it('reports imports below active holds with SKU and numbers, allows the floor and above', async () => {
    const sku = SKU.pinkBow16;
    const token = await hold(sku, 3, 'catalog-import');
    try {
      const v = await variant(sku);
      const { physical, reserved } = await inventoryOf(sku);
      expect(reserved).toBe(3);
      const conflicts = await inventory.findStockFloorConflicts([
        { variant: v, quantity: reserved - 1 },
      ]);
      expect(conflicts).toEqual([{ sku, requested_physical_stock: reserved - 1, reserved_quantity: 3, minimum_allowed_stock: 3 }]);
      expect(await inventory.findStockFloorConflicts([{ variant: v, quantity: reserved }])).toEqual([]);
      expect(await inventory.findStockFloorConflicts([{ variant: v, quantity: physical + 4 }])).toEqual([]);

      // The write path used inside the import transaction refuses and rolls back.
      await expect(db.sequelize.transaction(inventory.STOCK_TX, async (t) => {
        await db.ProductVariant.update({ price: 1 }, { where: { id: v.id }, transaction: t });
        await inventory.setPhysicalStock(v.id, reserved - 1, t);
      })).rejects.toMatchObject({ code: 'stock_below_reserved' });
      const after = await variant(sku);
      expect(after.stock_quantity).toBe(physical);
      expect(Number(after.price)).toBe(Number(v.price));
    } finally {
      await release(token);
    }
  });
});
