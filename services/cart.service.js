'use strict';

const db = require('../models');
const ApiError = require('../utils/ApiError');
const { computeCoverBundle } = require('./bundle.service');

async function getOrCreateCart(userId, transaction) {
  const [cart] = await db.Cart.findOrCreate({
    where: { user_id: userId },
    defaults: { user_id: userId },
    transaction,
  });
  return cart;
}

const cartItemInclude = [
  {
    model: db.ProductVariant,
    as: 'variant',
    include: [
      {
        model: db.Product,
        as: 'product',
        include: [
          { model: db.ProductImage, as: 'images' },
          { model: db.Category, as: 'category' },
        ],
      },
    ],
  },
];

async function shapeCart(cart, transaction) {
  const items = await db.CartItem.findAll({
    where: { cart_id: cart.id },
    include: cartItemInclude,
    order: [['id', 'ASC']],
    transaction,
  });

  const lines = items.map((item) => {
    const variant = item.variant;
    const product = variant?.product;
    const unitPrice = variant ? Number(variant.price) : 0;
    const available = variant ? variant.stock_quantity : 0;
    return {
      id: item.id,
      variant_id: item.variant_id,
      quantity: item.quantity,
      unit_price: unitPrice,
      line_total: Number((unitPrice * item.quantity).toFixed(2)),
      available_stock: available,
      stock_ok: variant ? variant.is_active && available >= item.quantity : false,
      category_slug: product?.category?.slug || null,
      product: product
        ? {
            id: product.id,
            name: product.name,
            slug: product.slug,
            image: product.images?.[0]?.url || null,
          }
        : null,
      sku: variant?.sku || null,
    };
  });

  const subtotal = Number(lines.reduce((sum, l) => sum + l.line_total, 0).toFixed(2));

  // "Buy 2 iPhone Covers for 1199" — shown as its own line, not folded into the subtotal.
  const bundle = computeCoverBundle(lines);

  return {
    id: cart.id,
    items: lines.map(({ category_slug, ...l }) => l),
    subtotal,
    covers_qty: bundle.covers_qty,
    bundle_discount: bundle.discount,
    estimated_total: Number(Math.max(subtotal - bundle.discount, 0).toFixed(2)),
    item_count: lines.reduce((n, l) => n + l.quantity, 0),
    has_stock_issue: lines.some((l) => !l.stock_ok),
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
    if (nextQty > variant.stock_quantity) {
      throw ApiError.badRequest(
        `Only ${variant.stock_quantity} in stock`,
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
    if (quantity > item.variant.stock_quantity) {
      throw ApiError.badRequest(`Only ${item.variant.stock_quantity} in stock`, 'insufficient_stock');
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
};
