'use strict';

const { Op } = require('sequelize');
const db = require('../models');
const ApiError = require('../utils/ApiError');
const { generateOrderNumber } = require('../utils/orderNumber');
const { validateCoupon } = require('./coupon.service');
const { resolveShipping } = require('./settings.service');
const { computeCoverBundle } = require('./bundle.service');
const loyalty = require('./loyalty.service');
const env = require('../config/env');

const { ORDER_STATUSES } = require('../models/order.model');

// Allowed forward transitions. 'cancelled' reachable from any non-terminal state.
const STATUS_FLOW = {
  pending: ['processing', 'shipped', 'cancelled'],
  processing: ['shipped', 'delivered', 'cancelled'],
  shipped: ['delivered', 'cancelled'],
  delivered: [],
  cancelled: [],
};

async function loadCartLines(userId, transaction) {
  const cart = await db.Cart.findOne({ where: { user_id: userId }, transaction });
  if (!cart) throw ApiError.badRequest('Cart is empty', 'cart_empty');
  const items = await db.CartItem.findAll({
    where: { cart_id: cart.id },
    include: [
      {
        model: db.ProductVariant,
        as: 'variant',
        include: [
          { model: db.Product, as: 'product', include: [{ model: db.Category, as: 'category' }] },
        ],
      },
    ],
    transaction,
  });
  if (items.length === 0) throw ApiError.badRequest('Cart is empty', 'cart_empty');
  return { cart, items };
}

async function requireOwnedAddress(userId, addressId, transaction) {
  const address = await db.Address.findOne({
    where: { id: addressId, user_id: userId },
    transaction,
  });
  if (!address) throw ApiError.badRequest('Address not found', 'address_not_found');
  return address;
}

/**
 * Compute the money breakdown for a set of cart items.
 * Pure-ish: reads coupon/shipping/tax config but writes nothing.
 */
async function computeTotals({ userId, items, shippingAddress, couponCode, redeemPoints = 0 }, transaction) {
  const lines = items.map((item) => {
    const variant = item.variant;
    if (!variant || !variant.is_active) {
      throw ApiError.badRequest('A product in your cart is no longer available', 'variant_unavailable');
    }
    if (variant.stock_quantity < item.quantity) {
      throw ApiError.badRequest(
        `Insufficient stock for ${variant.product?.name || variant.sku}`,
        'insufficient_stock'
      );
    }
    const unitPrice = Number(variant.price);
    const lineTotal = Number((unitPrice * item.quantity).toFixed(2));
    return {
      variant,
      variant_id: variant.id,
      product_name_snap: variant.product?.name || 'Product',
      sku_snap: variant.sku,
      category_slug: variant.product?.category?.slug || null,
      unit_price: unitPrice,
      quantity: item.quantity,
      line_total: lineTotal,
    };
  });

  const subtotal = Number(lines.reduce((s, l) => s + l.line_total, 0).toFixed(2));

  // "Buy 2 iPhone Covers for 1199" — applied first, before any coupon or points.
  const bundle = computeCoverBundle(lines);
  const bundleDiscount = bundle.discount;
  const subtotalAfterBundle = Number(Math.max(subtotal - bundleDiscount, 0).toFixed(2));

  let discount = 0;
  let coupon = null;
  if (couponCode) {
    // Coupon applies on top of the bundle price, not the pre-bundle subtotal.
    const res = await validateCoupon(
      { code: couponCode, userId, subtotal: subtotalAfterBundle },
      transaction
    );
    coupon = res.coupon;
    discount = res.discount_amount;
  }

  let pointsDiscount = 0;
  let pointsToRedeem = 0;
  if (redeemPoints > 0) {
    const balance = await loyalty.getBalance(userId);
    pointsToRedeem = Math.min(redeemPoints, balance);
    const maxValue = Number((subtotalAfterBundle - discount).toFixed(2));
    pointsDiscount = Math.min(loyalty.pointsToCurrency(pointsToRedeem), maxValue);
    pointsDiscount = Number(pointsDiscount.toFixed(2));
  }

  const totalDiscount = Number((discount + pointsDiscount).toFixed(2));
  const discountedSubtotal = Number(Math.max(subtotalAfterBundle - totalDiscount, 0).toFixed(2));

  const { cost: shippingAmount, rate: shippingRate } = await resolveShipping({
    address: shippingAddress,
    subtotal,
  });

  // No sales tax is charged on orders.
  const taxAmount = 0;

  const total = Number((discountedSubtotal + shippingAmount).toFixed(2));

  return {
    lines,
    subtotal,
    covers_qty: bundle.covers_qty,
    bundle_discount: bundleDiscount,
    coupon,
    coupon_discount: discount,
    points_redeemed: pointsToRedeem,
    points_discount: pointsDiscount,
    discount_amount: totalDiscount,
    shipping_amount: shippingAmount,
    shipping_rate: shippingRate,
    tax_amount: taxAmount,
    total_amount: total,
  };
}

async function previewOrder(userId, { shipping_address_id, coupon_code, redeem_points }) {
  const { items } = await loadCartLines(userId);
  const shippingAddress = await requireOwnedAddress(userId, shipping_address_id);
  const totals = await computeTotals({
    userId,
    items,
    shippingAddress,
    couponCode: coupon_code,
    redeemPoints: redeem_points || 0,
  });
  const { lines, coupon, shipping_rate, ...rest } = totals;
  return {
    ...rest,
    coupon: coupon ? { code: coupon.code, description: coupon.description } : null,
    shipping_method: shipping_rate
      ? `${shipping_rate.method_name} shipping to ${shipping_rate.zone_name}`
      : null,
    lines: lines.map((l) => ({
      variant_id: l.variant_id,
      name: l.product_name_snap,
      sku: l.sku_snap,
      unit_price: l.unit_price,
      quantity: l.quantity,
      line_total: l.line_total,
    })),
  };
}

async function placeOrder(userId, payload) {
  const { shipping_address_id, billing_address_id, coupon_code, redeem_points } = payload;

  return db.sequelize.transaction(async (t) => {
    const { cart, items } = await loadCartLines(userId, t);

    const shippingAddress = await requireOwnedAddress(userId, shipping_address_id, t);
    const billingAddress = billing_address_id
      ? await requireOwnedAddress(userId, billing_address_id, t)
      : shippingAddress;

    // Re-lock variants and re-check stock inside the transaction.
    const variantIds = items.map((i) => i.variant_id);
    const variants = await db.ProductVariant.findAll({
      where: { id: { [Op.in]: variantIds } },
      lock: t.LOCK.UPDATE,
      transaction: t,
    });
    const variantMap = new Map(variants.map((v) => [v.id, v]));
    for (const item of items) {
      const lockedVariant = variantMap.get(item.variant_id);
      if (lockedVariant) {
        // Keep the product+category eager-loaded by loadCartLines (needed for the
        // name snapshot and the cover-bundle category check); only the locked
        // stock/price fields matter from the re-read.
        lockedVariant.product = item.variant?.product || null;
        item.variant = lockedVariant;
      }
      if (item.variant && !item.variant.product) {
        item.variant.product = await db.Product.findByPk(item.variant.product_id, {
          include: [{ model: db.Category, as: 'category' }],
          transaction: t,
        });
      }
    }

    const totals = await computeTotals(
      {
        userId,
        items,
        shippingAddress,
        couponCode: coupon_code,
        redeemPoints: redeem_points || 0,
      },
      t
    );

    const order = await db.Order.create(
      {
        order_number: generateOrderNumber(),
        user_id: userId,
        status: 'pending',
        subtotal_amount: totals.subtotal,
        discount_amount: totals.discount_amount,
        bundle_discount_amount: totals.bundle_discount,
        tax_amount: totals.tax_amount,
        shipping_amount: totals.shipping_amount,
        total_amount: totals.total_amount,
        coupon_id: totals.coupon ? totals.coupon.id : null,
        shipping_address_id: shippingAddress.id,
        billing_address_id: billingAddress.id,
      },
      { transaction: t }
    );

    await db.OrderItem.bulkCreate(
      totals.lines.map((l) => ({
        order_id: order.id,
        variant_id: l.variant_id,
        product_name_snap: l.product_name_snap,
        sku_snap: l.sku_snap,
        unit_price: l.unit_price,
        quantity: l.quantity,
        line_total: l.line_total,
      })),
      { transaction: t }
    );

    // Decrement stock.
    for (const line of totals.lines) {
      const variant = variantMap.get(line.variant_id);
      variant.stock_quantity -= line.quantity;
      await variant.save({ transaction: t });
    }

    // Record coupon usage.
    if (totals.coupon) {
      await db.CouponUsage.create(
        { coupon_id: totals.coupon.id, user_id: userId, order_id: order.id },
        { transaction: t }
      );
    }

    // Redeem loyalty points (negative ledger row).
    if (totals.points_redeemed > 0) {
      await loyalty.redeemPoints(
        {
          userId,
          points: totals.points_redeemed,
          orderId: order.id,
          note: `Redeemed on order ${order.order_number}`,
        },
        t
      );
    }

    // Initial status history row.
    await db.OrderStatusHistory.create(
      { order_id: order.id, status: 'pending', note: 'Order placed' },
      { transaction: t }
    );

    await db.OrderPaymentConfirmation.create(
      {
        order_id: order.id,
        method: 'advance_qr',
        advance_amount: env.payment.advanceAmount,
        status: 'pending',
      },
      { transaction: t }
    );

    // Empty the cart.
    await db.CartItem.destroy({ where: { cart_id: cart.id }, transaction: t });

    return getUserOrder(userId, order.id, t);
  });
}

const orderInclude = [
  {
    model: db.OrderItem,
    as: 'items',
    include: [
      {
        model: db.ProductVariant,
        as: 'variant',
        include: [{ model: db.Product, as: 'product', attributes: ['id', 'name', 'slug'] }],
      },
    ],
  },
  { model: db.OrderStatusHistory, as: 'statusHistory', separate: true, order: [['changed_at', 'ASC']] },
  { model: db.Address, as: 'shippingAddress' },
  { model: db.Address, as: 'billingAddress' },
  { model: db.Coupon, as: 'coupon' },
  { model: db.OrderPaymentConfirmation, as: 'paymentConfirmation' },
];

function shapeOrder(order) {
  const o = order.get ? order.get({ plain: true }) : order;
  return o;
}

async function listUserOrders(userId, { page = 1, limit = 20, status } = {}) {
  const where = { user_id: userId };
  if (status) where.status = status;
  const { rows, count } = await db.Order.findAndCountAll({
    where,
    include: [{ model: db.OrderItem, as: 'items' }],
    order: [['placed_at', 'DESC']],
    limit,
    offset: (page - 1) * limit,
    distinct: true,
  });
  return {
    data: rows.map(shapeOrder),
    pagination: { page, limit, total: count, pages: Math.ceil(count / limit) },
  };
}

async function getUserOrder(userId, orderId, transaction) {
  const order = await db.Order.findOne({
    where: { id: orderId, user_id: userId },
    include: orderInclude,
    transaction,
  });
  if (!order) throw ApiError.notFound('Order not found', 'order_not_found');
  return shapeOrder(order);
}

/* ------------------------------- Admin ------------------------------- */

async function adminListOrders({ page = 1, limit = 20, status, q } = {}) {
  const where = {};
  if (status) where.status = status;
  if (q) where.order_number = { [Op.like]: `%${q}%` };
  const { rows, count } = await db.Order.findAndCountAll({
    where,
    include: [{ model: db.User, as: 'user', attributes: ['id', 'name', 'email'] }],
    order: [['placed_at', 'DESC']],
    limit,
    offset: (page - 1) * limit,
    distinct: true,
  });
  return {
    data: rows.map(shapeOrder),
    pagination: { page, limit, total: count, pages: Math.ceil(count / limit) },
  };
}

async function adminGetOrder(orderId, transaction) {
  const order = await db.Order.findByPk(orderId, {
    include: [...orderInclude, { model: db.User, as: 'user', attributes: ['id', 'name', 'email'] }],
    transaction,
  });
  if (!order) throw ApiError.notFound('Order not found', 'order_not_found');
  return shapeOrder(order);
}

async function transitionOrderStatus(orderId, { status, note }, staffId, transaction) {
  if (!ORDER_STATUSES.includes(status)) {
    throw ApiError.badRequest('Unknown status', 'bad_status');
  }
  const transition = async (t) => {
    const order = await db.Order.findByPk(orderId, {
      include: [{ model: db.OrderItem, as: 'items' }],
      lock: t.LOCK.UPDATE,
      transaction: t,
    });
    if (!order) throw ApiError.notFound('Order not found', 'order_not_found');
    if (order.status === status) return adminGetOrder(orderId, t);

    const allowed = STATUS_FLOW[order.status] || [];
    if (!allowed.includes(status)) {
      throw ApiError.badRequest(
        `Cannot move order from ${order.status} to ${status}`,
        'illegal_transition'
      );
    }

    // Restock on cancellation.
    if (status === 'cancelled') {
      for (const item of order.items) {
        await db.ProductVariant.increment(
          { stock_quantity: item.quantity },
          { where: { id: item.variant_id }, transaction: t }
        );
      }
    }

    order.status = status;
    await order.save({ transaction: t });
    await db.OrderStatusHistory.create(
      { order_id: order.id, status, changed_by_staff_id: staffId || null, note: note || null },
      { transaction: t }
    );

    // Award loyalty points once delivered.
    if (status === 'delivered') {
      await loyalty.awardForDeliveredOrder(order, t);
    }

    return adminGetOrder(orderId, t);
  };
  return transaction ? transition(transaction) : db.sequelize.transaction(transition);
}

async function updateOrderStatus(orderId, payload, staffId) {
  return transitionOrderStatus(orderId, payload, staffId);
}

module.exports = {
  STATUS_FLOW,
  computeTotals,
  previewOrder,
  placeOrder,
  listUserOrders,
  getUserOrder,
  adminListOrders,
  adminGetOrder,
  transitionOrderStatus,
  updateOrderStatus,
};
