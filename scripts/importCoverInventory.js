'use strict';

/**
 * One-off importer for the supplier phone-cover inventory spreadsheet.
 * Usage: node scripts/importCoverInventory.js
 *
 * Reads ../../cover-inventory-import.json (array of { design_name, variants: [...] })
 * and, using the project's Sequelize models:
 *
 *   1. Creates one Product per design under the "iPhone Covers" category
 *      (base_price 699, status active). Re-runnable: a design whose name already
 *      exists as an iPhone Covers product is skipped, not duplicated. Name match
 *      is case-insensitive (the column collation is utf8mb4_unicode_ci), so
 *      "Shiny bow iconic" is treated as the existing "shiny bow iconic".
 *
 *   2. Creates one Product Variant per model row: price 699 (flat), the given
 *      stock_quantity, is_active = true even at 0 stock, and a unique SKU
 *      `{design-slug}-{model-slug}-{4 random alnum}`. The variant's "Phone Model"
 *      attribute value is set to the model string verbatim ("iPhone 11 Pro Max").
 *      "Phone Model" is linked to the iPhone Covers category first if it isn't
 *      already.
 *
 *   3. Three rows carry a `note` ("black" / "black" / "skyblue") — a colour that
 *      was jammed into the quantity cell upstream. These are NOT guessed at; they
 *      are listed at the end for manual review (consider a Color attribute value).
 *
 *   4. Prints a summary: products created, variants created, designs skipped as
 *      already existing, and the flagged rows.
 */

const fs = require('fs');
const path = require('path');
const db = require('../models');
const { slugify } = require('../utils/slug');

const DATA_PATH = path.resolve(__dirname, '..', '..', 'cover-inventory-import.json');
const COVERS_CATEGORY_SLUG = 'iphone-covers';
const PHONE_MODEL_ATTR = 'Phone Model';
const BASE_PRICE = 699;
const VARIANT_PRICE = 699;

const SKU_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

function randomSuffix(len = 4) {
  let s = '';
  for (let i = 0; i < len; i += 1) {
    s += SKU_ALPHABET[Math.floor(Math.random() * SKU_ALPHABET.length)];
  }
  return s;
}

/**
 * A SKU unique both against the database and against SKUs minted earlier in this
 * same run. Regenerates the random suffix on collision.
 */
async function makeUniqueSku(designSlug, modelSlug, usedThisRun, transaction) {
  const stem = `${designSlug}-${modelSlug}`;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const sku = `${stem}-${randomSuffix()}`;
    if (usedThisRun.has(sku)) continue; // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    const clash = await db.ProductVariant.findOne({ where: { sku }, transaction });
    if (!clash) {
      usedThisRun.add(sku);
      return sku;
    }
  }
}

async function main() {
  await db.sequelize.authenticate();

  const designs = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));

  const covers = await db.Category.findOne({ where: { slug: COVERS_CATEGORY_SLUG } });
  if (!covers) {
    throw new Error(
      `Category "${COVERS_CATEGORY_SLUG}" not found — run the seed first (node scripts/seed.js).`
    );
  }

  // Ensure the "Phone Model" attribute exists and is linked to iPhone Covers.
  const [phoneModelAttr] = await db.Attribute.findOrCreate({
    where: { name: PHONE_MODEL_ATTR },
    defaults: { name: PHONE_MODEL_ATTR },
  });
  const [, linkCreated] = await db.CategoryAttribute.findOrCreate({
    where: { category_id: covers.id, attribute_id: phoneModelAttr.id },
    defaults: { category_id: covers.id, attribute_id: phoneModelAttr.id },
  });
  if (linkCreated) {
    console.info(`Linked "${PHONE_MODEL_ATTR}" attribute to the iPhone Covers category.`);
  }

  const usedSkus = new Set();
  let productsCreated = 0;
  let variantsCreated = 0;
  const skipped = [];
  const flagged = [];

  for (const design of designs) {
    const name = design.design_name;
    const designSlug = slugify(name);

    // Collect the flagged colour rows regardless of whether we create the product.
    for (const v of design.variants) {
      if (v.note != null && String(v.note).trim() !== '') {
        flagged.push({ design: name, phone_model: v.phone_model, note: v.note });
      }
    }

    // Dedup by product name within the iPhone Covers category (case-insensitive
    // via the column collation).
    const existing = await db.Product.findOne({
      where: { category_id: covers.id, name },
    });
    if (existing) {
      skipped.push(name);
      console.info(`skip   ${name} — already exists (product #${existing.id})`);
      continue;
    }

    // eslint-disable-next-line no-await-in-loop
    await db.sequelize.transaction(async (t) => {
      const product = await db.Product.create(
        {
          category_id: covers.id,
          name,
          slug: designSlug,
          description: null,
          base_price: BASE_PRICE,
          status: 'active',
        },
        { transaction: t }
      );
      productsCreated += 1;

      for (const v of design.variants) {
        const modelSlug = slugify(v.phone_model);
        // eslint-disable-next-line no-await-in-loop
        const sku = await makeUniqueSku(designSlug, modelSlug, usedSkus, t);
        // eslint-disable-next-line no-await-in-loop
        const variant = await db.ProductVariant.create(
          {
            product_id: product.id,
            sku,
            price: VARIANT_PRICE,
            stock_quantity: v.stock_quantity,
            is_active: true, // keep 0-stock variants visible as "out of stock"
          },
          { transaction: t }
        );
        // eslint-disable-next-line no-await-in-loop
        await db.VariantAttributeValue.create(
          {
            variant_id: variant.id,
            attribute_id: phoneModelAttr.id,
            value: v.phone_model,
          },
          { transaction: t }
        );
        variantsCreated += 1;
      }

      console.info(`create ${name} — ${design.variants.length} variant(s)`);
    });
  }

  console.info('\n──────────────────────────────────────────────');
  console.info('Import summary');
  console.info('──────────────────────────────────────────────');
  console.info(`Products created:            ${productsCreated}`);
  console.info(`Variants created:            ${variantsCreated}`);
  console.info(`Designs skipped (existing):  ${skipped.length}${skipped.length ? `  [${skipped.join(', ')}]` : ''}`);
  console.info(`Rows needing manual review:  ${flagged.length}`);
  for (const f of flagged) {
    console.info(
      `  • ${f.design} / ${f.phone_model}: note "${f.note}" — needs manual review — consider adding a Color attribute value`
    );
  }
  console.info('──────────────────────────────────────────────');

  await db.sequelize.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
