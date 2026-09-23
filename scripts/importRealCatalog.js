'use strict';

/*
 * Imports the owner-approved CaseVerse cover catalogue.
 *
 * The inventory snapshot was reconciled from Phone_Cover_Inventory.xlsx before
 * this script was written. It intentionally contains no customer/order data and
 * does not read or copy the source workbook into this repository.
 *
 * Usage: node scripts/importRealCatalog.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const { Op } = require('sequelize');
const db = require('../models');
const { slugify } = require('../utils/slug');

const CATEGORY_SLUG = 'iphone-covers';
const PHONE_MODEL = 'Phone Model';
const PRICE = 699;
const COMPARE_AT_PRICE = 999;
const DEMO_PRODUCTS = ['Silicone MagSafe Case', 'Clear Shockproof Bumper'];
const ASSET_DIRECTORY = path.resolve(__dirname, '..', '..', 'client', 'public', 'assets', 'caseverse');

function design(name, image, variants) {
  return { name, image, variants };
}

// One design is one product; the spreadsheet models below are variants.
const CATALOG = [
  design('Flame Black', 'Flame_black.png', [['iPhone 11 Pro', 1], ['iPhone 13 Pro', 2], ['iPhone 14', 3], ['iPhone 14 Pro', 1]]),
  design('Flame silver', 'Flame_silver.png', [['iPhone 11 Pro', 1]]),
  design('Cast case Black', 'Cat_black.png', [['iPhone 11 Pro Max', 1], ['iPhone 16', 1]]),
  design('Cat Case Sky blue', 'Cat_skyblue.png', [['iPhone 16 Pro Max', 1]]),
  design('Shiny bow iconic', 'Shiny_bow_iconic.png', [['iPhone 11 Pro Max', 1], ['iPhone 12', 3], ['iPhone 12 Pro Max', 2], ['iPhone 13', 3], ['iPhone 13 Pro', 2], ['iPhone 13 Pro Max', 1], ['iPhone 14', 1], ['iPhone 14 Pro', 2], ['iPhone 15 Pro', 1], ['iPhone 16 Pro Max', 1]]),
  design('Chetah iconic', 'Chetah_iconic.png', [['iPhone 11 Pro Max', 1], ['iPhone 12', 4], ['iPhone 12 Pro Max', 2], ['iPhone 13', 4], ['iPhone 13 Pro', 4], ['iPhone 13 Pro Max', 3], ['iPhone 14', 5], ['iPhone 14 Pro', 2], ['iPhone 15 Pro', 2], ['iPhone 15 Pro Max', 1]]),
  design('Pink love bow', 'Pink_love_bow.png', [['iPhone 12', 5], ['iPhone 12 Pro Max', 4], ['iPhone 13 Pro Max', 1], ['iPhone 14 Pro Max', 2], ['iPhone 16', 1], ['iPhone 17', 1]]),
  design('Flower bouquet', 'Flower_bouquet.png', [['iPhone 12', 6], ['iPhone 12 Pro Max', 3], ['iPhone 13 Pro Max', 2], ['iPhone 14 Pro Max', 4], ['iPhone 15 Pro Max', 2], ['iPhone 16', 2], ['iPhone 17', 2]]),
  design('Bow cherry iconic', 'Bow_cherry_iconic.png', [['iPhone 12', 3], ['iPhone 13', 3], ['iPhone 13 Pro Max', 6], ['iPhone 14', 5], ['iPhone 15', 3], ['iPhone 15 Pro Max', 2], ['iPhone 16 Pro Max', 1], ['iPhone 17', 2]]),
  design('Hello kitty', 'Hello_kitty.png', [['iPhone 12 Pro Max', 2], ['iPhone 13 Pro Max', 1]]),
  design('Evil eye', 'Evileye.png', [['iPhone 12 Pro Max', 1], ['iPhone 13 Pro Max', 2]]),
  design('Polka red', 'Polka_red.jpeg', [['iPhone 13', 4], ['iPhone 14', 5]]),
  design('Tulip shiny iconic', 'Tulip_iconic.png', [['iPhone 13 Pro', 1], ['iPhone 13 Pro Max', 3], ['iPhone 15 Pro', 1], ['iPhone 15 Pro Max', 2]]),
  design('Flower Bird', 'Flower_bird.png', [['iPhone 13 Pro Max', 1], ['iPhone 15 Pro Max', 2]]),
  design('Glossy white', 'Glossy_white.png', [['iPhone 14', 1]]),
  design('Glossy black', 'Glossy_black.png', [['iPhone 14', 1]]),
  design('Shiny pink bow', 'Shiny_pink_bow.png', [['iPhone 14 Pro', 1]]),
  design('Shiny leopard', 'Shiny_leopard.png', [['iPhone 14 Pro', 1]]),
  design('Cherry bow', 'Cherry_bow.png', [['iPhone 15', 5]]),
  design('Ying', 'Ying.png', [['iPhone 15', 2]]),
  design('Pink Floral', 'Pink_floral.png', [['iPhone 15 Pro', 3], ['iPhone 17 Pro', 1]]),
  design('Blue floral', 'Blue_floral.png', [['iPhone 15 Pro', 2], ['iPhone 16 Pro', 1], ['iPhone 17', 1], ['iPhone 17 Pro', 2], ['iPhone 17 Pro Max', 1]]),
  design('Polka dot', 'Polka_dot.png', [['iPhone 16', 1]]),
  design('Luffy Gear 5', 'Luffy.png', [['iPhone 16', 1]]),
];

function validateCatalog() {
  const seen = new Set();
  for (const item of CATALOG) {
    if (!fs.existsSync(path.join(ASSET_DIRECTORY, item.image))) throw new Error(`Missing public asset: ${item.image}`);
    for (const [model, quantity] of item.variants) {
      const key = `${item.name}\u0000${model}`;
      if (seen.has(key)) throw new Error(`Duplicate product/model row: ${item.name} / ${model}`);
      seen.add(key);
      if (!Number.isInteger(quantity) || quantity < 0) throw new Error(`Invalid quantity for ${item.name} / ${model}`);
    }
  }
  const total = CATALOG.flatMap((item) => item.variants).reduce((sum, [, quantity]) => sum + quantity, 0);
  if (CATALOG.length !== 24 || seen.size !== 76 || total !== 165) {
    throw new Error(`Reconciliation invariant failed: products=${CATALOG.length}, variants=${seen.size}, stock=${total}`);
  }
  return { products: CATALOG.length, variants: seen.size, stock: total };
}

function skuFor(productName, model) {
  return `CV-${slugify(productName)}-${slugify(model)}`.slice(0, 64).toUpperCase();
}

async function writeBackup() {
  const products = await db.Product.findAll({
    include: [
      { model: db.ProductVariant, as: 'variants', include: [{ model: db.VariantAttributeValue, as: 'attributeValues' }] },
      { model: db.ProductImage, as: 'images' },
    ],
  });
  const backupDirectory = path.resolve(__dirname, '..', '.tmp', 'catalog-backups');
  fs.mkdirSync(backupDirectory, { recursive: true });
  const backupPath = path.join(backupDirectory, `catalog-before-real-import-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(products.map((p) => p.toJSON()), null, 2), { encoding: 'utf8', flag: 'wx' });
  return backupPath;
}

async function findVariant(productId, attributeId, model, transaction) {
  return db.ProductVariant.findOne({
    where: { product_id: productId },
    include: [{ model: db.VariantAttributeValue, as: 'attributeValues', where: { attribute_id: attributeId, value: model }, required: true }],
    transaction,
  });
}

async function deactivateSafeDemoProducts(transaction) {
  const products = await db.Product.findAll({ where: { name: { [Op.in]: DEMO_PRODUCTS } }, transaction });
  let deactivated = 0;
  for (const product of products) {
    // Inactivation removes a demo item from the storefront without deleting its
    // product, variants, or any order-item references to them.
    await product.update({ status: 'inactive' }, { transaction });
    await db.ProductVariant.update({ is_active: false }, { where: { product_id: product.id }, transaction });
    deactivated += 1;
  }
  return deactivated;
}

async function verify() {
  const [skuDuplicates] = await db.sequelize.query('SELECT sku FROM product_variants GROUP BY sku HAVING COUNT(*) > 1');
  const [negativeStock] = await db.sequelize.query('SELECT id FROM product_variants WHERE stock_quantity < 0');
  const [orphanVariants] = await db.sequelize.query('SELECT pv.id FROM product_variants pv LEFT JOIN products p ON p.id = pv.product_id WHERE p.id IS NULL');
  const products = await db.Product.findAll({ where: { slug: { [Op.in]: CATALOG.map((item) => slugify(item.name)) } } });
  const importedProductIds = products.map((p) => p.id);
  const [stockRows] = importedProductIds.length
    ? await db.sequelize.query('SELECT COALESCE(SUM(stock_quantity), 0) AS total FROM product_variants WHERE product_id IN (:ids)', { replacements: { ids: importedProductIds } })
    : [[{ total: 0 }]];
  const images = await db.ProductImage.findAll({ where: { product_id: { [Op.in]: importedProductIds }, variant_id: null } });
  const expectedImages = new Set(CATALOG.map((item) => `/assets/caseverse/${item.image}`));
  const missingImages = CATALOG.filter((item) => !images.some((image) => image.url === `/assets/caseverse/${item.image}`));
  return {
    skuDuplicates: skuDuplicates.length,
    negativeStock: negativeStock.length,
    orphanVariants: orphanVariants.length,
    missingImages: missingImages.length,
    totalStock: Number(stockRows[0].total),
    products: products.length,
    expectedImages: expectedImages.size,
  };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const invariant = validateCatalog();
  // Keep local import output limited to reconciliation and verification facts.
  db.sequelize.options.logging = false;
  await db.sequelize.authenticate();
  console.info(`Validated ${invariant.variants} rows: ${invariant.products} products, ${invariant.stock} total stock.`);
  if (dryRun) return;

  const backupPath = await writeBackup();
  const result = await db.sequelize.transaction(async (transaction) => {
    const category = await db.Category.findOne({ where: { slug: CATEGORY_SLUG }, transaction });
    if (!category) throw new Error(`Category "${CATEGORY_SLUG}" is required before import.`);
    const [phoneModelAttribute] = await db.Attribute.findOrCreate({ where: { name: PHONE_MODEL }, defaults: { name: PHONE_MODEL }, transaction });
    await db.CategoryAttribute.findOrCreate({ where: { category_id: category.id, attribute_id: phoneModelAttribute.id }, defaults: { category_id: category.id, attribute_id: phoneModelAttribute.id }, transaction });

    let createdProducts = 0;
    let createdVariants = 0;
    for (const item of CATALOG) {
      const slug = slugify(item.name);
      const [product, created] = await db.Product.findOrCreate({
        where: { slug },
        defaults: { category_id: category.id, name: item.name, slug, description: null, base_price: PRICE, status: 'active' },
        transaction,
      });
      if (created) createdProducts += 1;
      await product.update({ category_id: category.id, name: item.name, base_price: PRICE, status: 'active' }, { transaction });
      await db.ProductImage.findOrCreate({ where: { product_id: product.id, variant_id: null, url: `/assets/caseverse/${item.image}` }, defaults: { product_id: product.id, variant_id: null, url: `/assets/caseverse/${item.image}`, sort_order: 0 }, transaction });
      for (const [model, stock] of item.variants) {
        let variant = await findVariant(product.id, phoneModelAttribute.id, model, transaction);
        if (!variant) {
          const sku = skuFor(item.name, model);
          const conflict = await db.ProductVariant.findOne({ where: { sku }, transaction });
          if (conflict) throw new Error(`SKU belongs to a different variant: ${sku}`);
          variant = await db.ProductVariant.create({ product_id: product.id, sku, price: PRICE, compare_at_price: COMPARE_AT_PRICE, stock_quantity: stock, is_active: true }, { transaction });
          await db.VariantAttributeValue.create({ variant_id: variant.id, attribute_id: phoneModelAttribute.id, value: model }, { transaction });
          createdVariants += 1;
        } else {
          await variant.update({ price: PRICE, compare_at_price: COMPARE_AT_PRICE, stock_quantity: stock, is_active: true }, { transaction });
        }
      }
    }
    const deactivatedDemoProducts = await deactivateSafeDemoProducts(transaction);
    return { createdProducts, createdVariants, deactivatedDemoProducts };
  });
  const checks = await verify();
  if (checks.skuDuplicates || checks.negativeStock || checks.orphanVariants || checks.missingImages || checks.totalStock !== 165 || checks.products !== 24) {
    throw new Error(`Post-import verification failed: ${JSON.stringify(checks)}`);
  }
  console.info(JSON.stringify({ backupPath, ...result, ...checks }, null, 2));
}

main()
  .catch((error) => { console.error(error.message); process.exitCode = 1; })
  .finally(async () => { await db.sequelize.close(); });
