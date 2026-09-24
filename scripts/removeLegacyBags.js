'use strict';

/**
 * One-time, opt-in cleanup for development databases seeded before the
 * covers-only catalog change. It never deletes variants referenced by an order:
 * those products are deactivated so transactional history remains valid.
 */
const { Op } = require('sequelize');
const db = require('../models');
const cache = require('../services/cache.service');

const LEGACY_CATEGORY_SLUG = 'ladies-bags';
const LEGACY_ATTRIBUTE_NAMES = ['Material', 'Style'];

async function main() {
  await db.sequelize.authenticate();
  const category = await db.Category.findOne({ where: { slug: LEGACY_CATEGORY_SLUG } });
  if (!category) {
    console.info('No legacy catalog category found. Nothing to clean up.');
    return;
  }

  const products = await db.Product.findAll({ where: { category_id: category.id } });
  let deleted = 0;
  let archived = 0;
  for (const product of products) {
    const variants = await db.ProductVariant.findAll({ where: { product_id: product.id } });
    const variantIds = variants.map((variant) => variant.id);
    const orderItemCount = variantIds.length
      ? await db.OrderItem.count({ where: { variant_id: { [Op.in]: variantIds } } })
      : 0;

    if (orderItemCount) {
      await db.sequelize.transaction(async (transaction) => {
        await product.update({ status: 'inactive' }, { transaction });
        await db.ProductVariant.update({ is_active: false }, { where: { product_id: product.id }, transaction });
      });
      archived += 1;
    } else {
      await product.destroy();
      deleted += 1;
    }
  }

  const remainingProducts = await db.Product.count({ where: { category_id: category.id } });
  if (!remainingProducts) await category.destroy();

  for (const name of LEGACY_ATTRIBUTE_NAMES) {
    const attribute = await db.Attribute.findOne({ where: { name } });
    if (!attribute) continue;
    const [categoryMappings, values] = await Promise.all([
      db.CategoryAttribute.count({ where: { attribute_id: attribute.id } }),
      db.VariantAttributeValue.count({ where: { attribute_id: attribute.id } }),
    ]);
    if (!categoryMappings && !values) await attribute.destroy();
  }

  console.info(`Removed ${deleted} legacy product(s); archived ${archived} product(s) with order history.`);
  if (remainingProducts) console.info('The legacy category remains only to preserve foreign-key-linked order history.');
  // Catalog changed: drop the public read cache (no-op when Redis is not configured).
  await cache.invalidateCatalog();
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => { await cache.close(); await db.sequelize.close(); });
