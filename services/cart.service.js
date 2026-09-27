'use strict';

const db = require('../models');
const ApiError = require('../utils/ApiError');
const inventory = require('./inventory.service');
const { computeCoverBundle, couponAllowed } = require('./bundle.service');
const { normalizeGuestItems } = require('./order.service');

async function getOrCreateCart(userId, transaction) {
  const [cart] = await db.Cart.findOrCreate({
    where: { user_id: userId },
    defaults: { user_id: userId },
    transaction,
  });
  return cart;
}

const variantInclude = [
  {
    model: db.VariantAttributeValue,
    as: 'attributeValues',
    include: [{ model: db.Attribute, as: 'attribute' }],
  },
  { model: db.ProductImage, as: 'images' },
  {
    model: db.Product,
    as: 'product',
    include: [
      { model: db.ProductImage, as: 'images' },
      { model: db.Category, as: 'category' },
    ],
  },
];

const cartItemInclude = [{ model: db.ProductVariant, as: 'variant', include: variantInclude }];

const bySortOrder = (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.id - b.id;

/** The chosen model's own picture when it has one, otherwise the product's first shared image. */
function lineImage(variant) {
  const own = [...(variant?.images || [])].sort(bySortOrder)[0];
  if (own) return own.url;
  const shared = (variant?.product?.images || []).filter((i) => i.variant_id == null).sort(bySortOrder)[0];
  return shared?.url || null;
}

/**
 * Shapes cart lines (each exposing `id`, `quantity` and a loaded `variant`)
 * into the one cart shape the storefront renders. Signed-in and guest carts
 * both go through here, so prices, stock and the Dashain bundle always come
 * from the server, never from what the browser remembers.
 */
async function shapeLines(items, transaction) {
  // Customers see what they can actually buy: physical minus active reservations.
  const availability = await inventory.availabilityFor(items.map((item) => item.variant).filter(Boolean), { transaction });
  const lines = items.map((item) => {
    const variant = item.variant;
    const product = variant?.product;
    const unitPrice = variant ? Number(variant.price) : 0;
    const available = variant ? availability.get(variant.id).available : 0;
    const attributes = (variant?.attributeValues || []).map((av) => ({ name: av.attribute?.name, value: av.value }));
    return {
      id: item.id,
      variant_id: item.variant_id,
      quantity: item.quantity,
      unit_price: unitPrice,
      compare_at_price: variant?.compare_at_price == null ? null : Number(variant.compare_at_price),
      line_total: Number((unitPrice * item.quantity).toFixed(2)),
      available_stock: available,
      stock_ok: variant ? variant.is_active && available >= item.quantity : false,
      category_slug: product?.category?.slug || null,
      attributes,
      model: attributes.map((a) => a.value).filter(Boolean).join(' / ') || null,
      product: product
        ? {
            id: product.id,
            name: product.name,
            slug: product.slug,
            image: lineImage(variant),
          }
        : null,
      sku: variant?.sku || null,
    };
  });

  const subtotal = Number(lines.reduce((sum, l) => sum + l.line_total, 0).toFixed(2));

  // Dashain campaign bundle — shown as its own line, not folded into the subtotal.
  const bundle = computeCoverBundle(lines);

  return {
    items: lines.map(({ category_slug, ...l }) => l),
    subtotal,
    covers_qty: bundle.covers_qty,
    bundle_discount: bundle.discount,
    campaign_active: bundle.campaign_active,
    bundle_pairs: bundle.pairs,
    coupon_allowed: couponAllowed(bundle),
    campaign_code: bundle.campaign_code,
    campaign_label: bundle.campaign_label,
    free_items: bundle.free_items,
    estimated_total: Number(Math.max(subtotal - bundle.discount, 0).toFixed(2)),
    item_count: lines.reduce((n, l) => n + l.quantity, 0),
    has_stock_issue: lines.some((l) => !l.stock_ok),
  };
}

async function shapeCart(cart, transaction) {
  const items = await db.CartItem.findAll({
    where: { cart_id: cart.id },
    include: cartItemInclude,
    order: [['id', 'ASC']],
    transaction,
  });
  return { id: cart.id, ...(await shapeLines(items, transaction)) };
}

/**
 * A guest's cart lives in their browser as { variant_id, quantity } pairs.
 * This prices and stock-checks those pairs exactly like a signed-in cart and
 * writes nothing. Variants that no longer exist come back in
 * `missing_variant_ids` so the browser can drop them.
 */
async function getGuestCart(rawItems) {
  const normalized = normalizeGuestItems(rawItems);
  const variants = await db.ProductVariant.findAll({
    where: { id: normalized.map((i) => i.variant_id) },
    include: variantInclude,
  });
  const byId = new Map(variants.map((v) => [v.id, v]));
  const present = normalized.filter((i) => byId.has(i.variant_id));
  const shaped = await shapeLines(present.map((i) => ({
    id: `guest-${i.variant_id}`,
    variant_id: i.variant_id,
    quantity: i.quantity,
    variant: byId.get(i.variant_id),
  })));
  return {
    ...shaped,
    missing_variant_ids: normalized.filter((i) => !byId.has(i.variant_id)).map((i) => i.variant_id),
  };
}

async function getCart(userId) {
  const cart = await getOrCreateCart(userId);
  return shapeCart(cart);
}

async function addItem(userId, { variant_id, quantity }) {
  return db.sequelize.transaction(async (t) => {
    const cart = await getOrCreateCart(userId, t);
    const variant = await db.ProductVariant.findByPk(variant_id, { transaction: t });
    if (!variant || !variant.is_active) {
      throw ApiError.notFound('Variant not available', 'variant_not_found');
    }

    const existing = await db.CartItem.findOne({
      where: { cart_id: cart.id, variant_id },
      transaction: t,
    });
    const nextQty = (existing ? existing.quantity : 0) + quantity;
    const { available } = (await inventory.availabilityFor([variant])).get(variant.id);
    if (nextQty > available) {
      throw ApiError.badRequest(
        `Only ${available} in stock`,
        'insufficient_stock'
      );
    }

    if (existing) {
      existing.quantity = nextQty;
      await existing.save({ transaction: t });
    } else {
      await db.CartItem.create({ cart_id: cart.id, variant_id, quantity }, { transaction: t });
    }
    await cart.changed('updated_at', true);
    await cart.save({ transaction: t });
    return shapeCart(cart, t);
  });
}

async function updateItem(userId, itemId, { quantity }) {
  return db.sequelize.transaction(async (t) => {
    const cart = await getOrCreateCart(userId, t);
    const item = await db.CartItem.findOne({
      where: { id: itemId, cart_id: cart.id },
      include: cartItemInclude,
      transaction: t,
    });
    if (!item) throw ApiError.notFound('Cart item not found', 'cart_item_not_found');

    if (quantity <= 0) {
      await item.destroy({ transaction: t });
      return shapeCart(cart, t);
    }
    const { available } = (await inventory.availabilityFor([item.variant])).get(item.variant.id);
    if (quantity > available) {
      throw ApiError.badRequest(`Only ${available} in stock`, 'insufficient_stock');
    }
    item.quantity = quantity;
    await item.save({ transaction: t });
    return shapeCart(cart, t);
  });
}

async function removeItem(userId, itemId) {
  const cart = await getOrCreateCart(userId);
  const item = await db.CartItem.findOne({ where: { id: itemId, cart_id: cart.id } });
  if (!item) throw ApiError.notFound('Cart item not found', 'cart_item_not_found');
  await item.destroy();
  return shapeCart(cart);
}

async function clearCart(userId, transaction) {
  const cart = await getOrCreateCart(userId, transaction);
  await db.CartItem.destroy({ where: { cart_id: cart.id }, transaction });
  return cart;
}

module.exports = {
  getOrCreateCart,
  getCart,
  addItem,
  updateItem,
  removeItem,
  clearCart,
  shapeCart,
  getGuestCart,
};
