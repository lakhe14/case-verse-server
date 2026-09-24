'use strict';

/**
 * Idempotent local-development seed data.
 * It creates roles, permissions and a safe demo catalogue without creating
 * source-controlled user passwords. Use `npm run dev:reset-accounts` locally
 * after configuring DEV_* values in server/.env when accounts are needed.
 */

const db = require('../models');
const cache = require('../services/cache.service');
const { slugify } = require('../utils/slug');

const PERMISSIONS = [
  ['manage_products', 'Create, edit and delete products, variants and images'],
  ['manage_orders', 'View orders and update their status'],
  ['manage_order_payments', 'Review advance-payment proofs and confirm COD orders'],
  ['manage_reviews', 'Approve or reject product reviews'],
  ['manage_coupons', 'Create and manage coupons and campaigns'],
  ['view_analytics', 'View sales and traffic analytics'],
  ['manage_customers', 'View customer accounts and history'],
  ['manage_staff', 'Manage staff accounts, roles and permissions'],
  ['manage_settings', 'Configure shipping, tax and store settings'],
];

const ROLES = {
  'Super Admin': PERMISSIONS.map((permission) => permission[0]),
  'Product Manager': ['manage_products', 'view_analytics'],
  'Order Manager': ['manage_orders', 'manage_order_payments', 'manage_reviews', 'manage_customers'],
  Support: ['manage_customers'],
};

async function seedRbac() {
  const permissionsByKey = {};
  for (const [key, label] of PERMISSIONS) {
    const [permission] = await db.Permission.findOrCreate({ where: { key }, defaults: { key, label } });
    permissionsByKey[key] = permission;
  }

  for (const [name, keys] of Object.entries(ROLES)) {
    const [role] = await db.Role.findOrCreate({ where: { name }, defaults: { name } });
    await role.setPermissions(keys.map((key) => permissionsByKey[key]));
  }
}

async function seedCatalog() {
  const attributesByName = {};
  for (const name of ['Phone Model', 'Color']) {
    const [attribute] = await db.Attribute.findOrCreate({ where: { name }, defaults: { name } });
    attributesByName[name] = attribute;
  }

  const [covers] = await db.Category.findOrCreate({
    where: { slug: 'iphone-covers' },
    defaults: { name: 'iPhone Covers', slug: 'iphone-covers' },
  });

  await db.CategoryAttribute.findOrCreate({
    where: { category_id: covers.id, attribute_id: attributesByName['Phone Model'].id },
  });
  await db.CategoryAttribute.findOrCreate({
    where: { category_id: covers.id, attribute_id: attributesByName.Color.id },
  });

  const products = [
    {
      name: 'Silicone MagSafe Case',
      description: 'Soft-touch silicone with MagSafe magnets and microfiber lining.',
      basePrice: 1490,
      variants: [
        { sku: 'CV-SIL-15PRO-BLK', price: 1490, stock: 40, attrs: { 'Phone Model': 'iPhone 15 Pro', Color: 'Black' } },
        { sku: 'CV-SIL-15PRO-BLU', price: 1490, stock: 25, attrs: { 'Phone Model': 'iPhone 15 Pro', Color: 'Storm Blue' } },
        { sku: 'CV-SIL-14-BLK', price: 1290, stock: 30, attrs: { 'Phone Model': 'iPhone 14', Color: 'Black' } },
      ],
    },
    {
      name: 'Clear Shockproof Bumper',
      description: 'Transparent hard back with a flexible shock-absorbing frame.',
      basePrice: 990,
      variants: [
        { sku: 'CV-CLR-15-CLR', price: 990, stock: 50, attrs: { 'Phone Model': 'iPhone 15', Color: 'Clear' } },
        { sku: 'CV-CLR-13-CLR', price: 890, stock: 20, attrs: { 'Phone Model': 'iPhone 13', Color: 'Clear' } },
      ],
    },
  ];

  for (const productSeed of products) {
    const slug = slugify(productSeed.name);
    const [product, created] = await db.Product.findOrCreate({
      where: { slug },
      defaults: {
        category_id: covers.id,
        name: productSeed.name,
        slug,
        description: productSeed.description,
        base_price: productSeed.basePrice,
        status: 'active',
      },
    });
    if (!created) continue;

    for (const variantSeed of productSeed.variants) {
      const variant = await db.ProductVariant.create({
        product_id: product.id,
        sku: variantSeed.sku,
        price: variantSeed.price,
        stock_quantity: variantSeed.stock,
      });
      for (const [attributeName, value] of Object.entries(variantSeed.attrs)) {
        await db.VariantAttributeValue.create({
          variant_id: variant.id,
          attribute_id: attributesByName[attributeName].id,
          value,
        });
      }
    }
    await db.ProductImage.create({
      product_id: product.id,
      url: `https://placehold.co/600x600?text=${encodeURIComponent(productSeed.name)}`,
      sort_order: 0,
    });
  }
}

async function seedSettingsAndCoupons() {
  const shipping = [
    { zone_name: 'Kathmandu', method_name: 'Standard', cost: 100, free_above_amount: 5000, is_active: true },
    { zone_name: 'Outside Valley', method_name: 'Standard', cost: 250, free_above_amount: 8000, is_active: true },
  ];
  for (const rate of shipping) {
    await db.ShippingRate.findOrCreate({
      where: { zone_name: rate.zone_name, method_name: rate.method_name },
      defaults: rate,
    });
  }

  const settings = {
    store_name: 'CaseVerse',
    contact_email: 'hello@caseverse.test',
    currency: 'NPR',
    support_phone: '+977-1-4000000',
  };
  for (const [key, value] of Object.entries(settings)) {
    await db.StoreSetting.findOrCreate({ where: { key }, defaults: { key, value } });
  }

  await db.Coupon.findOrCreate({
    where: { code: 'WELCOME10' },
    defaults: {
      code: 'WELCOME10',
      description: '10% off your first order',
      discount_type: 'percentage',
      discount_value: 10,
      min_order_amount: 1000,
      usage_limit_per_user: 1,
      is_active: true,
    },
  });
}

async function main() {
  await db.sequelize.authenticate();
  console.info('Seeding...');
  await seedRbac();
  await seedCatalog();
  await seedSettingsAndCoupons();
  // Catalog changed: drop the public read cache (no-op when Redis is not configured).
  await cache.invalidateCatalog();
  await cache.close();
  console.info('Done.');
  await db.sequelize.close();
}

// Exported so the isolated E2E fixture setup seeds the exact same RBAC matrix.
module.exports = { PERMISSIONS, ROLES, seedRbac };

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
