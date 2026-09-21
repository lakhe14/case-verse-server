'use strict';

/**
 * One-off cleanup: remove all (test) order data and repair the side effects.
 * Usage: node scripts/clearTestOrders.js
 *
 * Deletes, in FK-safe order: coupon_usages -> loyalty_transactions ->
 * order_status_history -> order_items -> orders. Keeps users, products,
 * variants, categories, attributes, coupons and reviews.
 *
 * Repairs afterwards:
 *   - Reviews whose `order_item_id` pointed at a deleted order_item have that
 *     link nulled (the review itself is kept; order_item_id is only a
 *     purchase-verification pointer).
 *   - iPhone Covers variants that match a row in cover-inventory-import.json are
 *     reset to that file's stock_quantity (source of truth after the import).
 *   - users.loyalty_points is recomputed from the (now trimmed) ledger for every
 *     affected customer — 0 when they had only order-tied 'earn' rows.
 *
 * Anything the script can't safely reconcile (cover products with no import row,
 * non-cover variants that test orders decremented) is listed for manual review
 * rather than guessed.
 */

const fs = require('fs');
const path = require('path');
const { Op } = require('sequelize');
const db = require('../models');
const loyalty = require('../services/loyalty.service');

const IMPORT_PATH = path.resolve(__dirname, '..', '..', 'cover-inventory-import.json');
const COVERS_CATEGORY_SLUG = 'iphone-covers';
const PHONE_MODEL_ATTR = 'Phone Model';

async function main() {
  await db.sequelize.authenticate();

  const orders = await db.Order.findAll({ attributes: ['id', 'user_id', 'order_number', 'status'] });
  const orderIds = orders.map((o) => o.id);
  console.info(`Found ${orderIds.length} order(s) to remove.`);

  // --- Snapshot what the order_items touched, before deleting them ---
  const orderItems = await db.OrderItem.findAll({
    where: { order_id: { [Op.in]: orderIds } },
    attributes: ['id', 'order_id', 'variant_id', 'product_name_snap', 'quantity'],
  });
  const orderStatusById = new Map(orders.map((o) => [o.id, o.status]));

  // Net units removed from stock per variant = sum of quantities on order_items
  // whose order was NOT cancelled (a cancelled order already restocked on cancel).
  const netRemovedByVariant = new Map();
  for (const it of orderItems) {
    if (orderStatusById.get(it.order_id) === 'cancelled') continue;
    netRemovedByVariant.set(
      it.variant_id,
      (netRemovedByVariant.get(it.variant_id) || 0) + it.quantity
    );
  }

  const affectedUserIds = [
    ...new Set(
      (
        await db.LoyaltyTransaction.findAll({
          where: { order_id: { [Op.in]: orderIds } },
          attributes: ['user_id'],
        })
      ).map((t) => t.user_id)
    ),
  ];

  const deletedItemIds = orderItems.map((i) => i.id);
  const reviewsToUnlink = deletedItemIds.length
    ? await db.Review.findAll({ where: { order_item_id: { [Op.in]: deletedItemIds } } })
    : [];

  // ---------------------------- Deletions ----------------------------
  const counts = {};
  counts.coupon_usages = await db.CouponUsage.destroy({ where: { order_id: { [Op.in]: orderIds } } });
  counts.loyalty_transactions = await db.LoyaltyTransaction.destroy({
    where: { order_id: { [Op.in]: orderIds } },
  });
  counts.order_status_history = await db.OrderStatusHistory.destroy({
    where: { order_id: { [Op.in]: orderIds } },
  });

  // Null the purchase link on any surviving review that pointed at a deleted item.
  let reviewsUnlinked = 0;
  if (reviewsToUnlink.length) {
    [reviewsUnlinked] = await db.Review.update(
      { order_item_id: null },
      { where: { order_item_id: { [Op.in]: deletedItemIds } } }
    );
  }

  counts.order_items = await db.OrderItem.destroy({ where: { order_id: { [Op.in]: orderIds } } });
  counts.orders = await db.Order.destroy({ where: { id: { [Op.in]: orderIds } } });

  // --------------------- Stock: iPhone Covers from import ---------------------
  const covers = await db.Category.findOne({ where: { slug: COVERS_CATEGORY_SLUG } });
  const phoneModelAttr = await db.Attribute.findOne({ where: { name: PHONE_MODEL_ATTR } });
  const importRows = JSON.parse(fs.readFileSync(IMPORT_PATH, 'utf8'));

  const coverProducts = await db.Product.findAll({
    where: { category_id: covers.id },
    include: [
      {
        model: db.ProductVariant,
        as: 'variants',
        include: [{ model: db.VariantAttributeValue, as: 'attributeValues' }],
      },
    ],
  });
  const productByName = new Map(coverProducts.map((p) => [p.name.toLowerCase(), p]));

  const stockCorrected = [];
  const importNoMatch = [];
  const importSkus = new Set();
  for (const design of importRows) {
    const product = productByName.get(design.design_name.toLowerCase());
    for (const row of design.variants) {
      const variant = product?.variants.find((v) =>
        v.attributeValues.some(
          (av) => av.attribute_id === phoneModelAttr.id && av.value === row.phone_model
        )
      );
      if (!variant) {
        importNoMatch.push(`${design.design_name} / ${row.phone_model}`);
        continue;
      }
      importSkus.add(variant.sku);
      if (variant.stock_quantity !== row.stock_quantity) {
        stockCorrected.push({
          sku: variant.sku,
          design: design.design_name,
          phone_model: row.phone_model,
          from: variant.stock_quantity,
          to: row.stock_quantity,
        });
        await variant.update({ stock_quantity: row.stock_quantity });
      }
    }
  }

  // -------- Variants touched by test orders that we did NOT auto-correct --------
  const needsManual = [];
  for (const [variantId, units] of netRemovedByVariant.entries()) {
    const variant = await db.ProductVariant.findByPk(variantId, {
      include: [{ model: db.Product, as: 'product', include: [{ model: db.Category, as: 'category' }] }],
    });
    if (!variant) continue;
    if (importSkus.has(variant.sku)) continue; // already reset from the import file
    needsManual.push({
      sku: variant.sku,
      product: variant.product?.name,
      category: variant.product?.category?.name,
      units_decremented_by_test_orders: units,
      current_stock: variant.stock_quantity,
      pre_test_stock_would_be: variant.stock_quantity + units,
    });
  }

  // --------------------- Loyalty points recompute ---------------------
  const loyaltyReset = [];
  for (const userId of affectedUserIds) {
    const total = await loyalty.recalcBalance(userId);
    loyaltyReset.push({ user_id: userId, new_balance: total });
  }

  // ------------------------------- Summary -------------------------------
  console.info('\n════════════════════ Cleanup summary ════════════════════');
  console.info('Rows deleted:');
  for (const [table, n] of Object.entries(counts)) console.info(`  ${table.padEnd(22)} ${n}`);

  console.info(`\nReviews kept, purchase link nulled: ${reviewsUnlinked}`);
  if (reviewsToUnlink.length) {
    for (const r of reviewsToUnlink) {
      console.info(`  review #${r.id} (product ${r.product_id}, user ${r.user_id}, status ${r.status})`);
    }
  }

  console.info(`\niPhone Covers stock reset from cover-inventory-import.json: ${stockCorrected.length} variant(s)`);
  for (const c of stockCorrected) {
    console.info(`  ${c.sku.padEnd(34)} ${c.design} / ${c.phone_model}: ${c.from} -> ${c.to}`);
  }
  if (importNoMatch.length) {
    console.info(`  (import rows with no matching variant, skipped: ${importNoMatch.length})`);
    for (const m of importNoMatch) console.info(`    - ${m}`);
  }

  console.info(`\nLoyalty balances recomputed: ${loyaltyReset.length} customer(s)`);
  for (const l of loyaltyReset) console.info(`  user ${l.user_id} -> ${l.new_balance} points`);

  console.info('\n─────────────── NEEDS YOUR MANUAL CONFIRMATION ───────────────');
  if (!needsManual.length) {
    console.info('  (none)');
  } else {
    console.info('  These variants were decremented by test orders and are NOT covered by');
    console.info('  the import file. Tell me the correct current stock for each:');
    for (const m of needsManual) {
      console.info(
        `  • ${m.sku} — ${m.product} [${m.category}]: ` +
          `${m.units_decremented_by_test_orders} unit(s) decremented by test orders, ` +
          `current stock ${m.current_stock} (pre-test would have been ${m.pre_test_stock_would_be})`
      );
    }
  }
  console.info('═════════════════════════════════════════════════════════');

  await db.sequelize.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
