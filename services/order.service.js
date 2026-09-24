'use strict';

const { Op } = require('sequelize');
const db = require('../models');
const ApiError = require('../utils/ApiError');
const { generateOrderNumber } = require('../utils/orderNumber');
const { validateCoupon } = require('./coupon.service');
const parcelmoover = require('./parcelmoover.service');
const { computeCoverBundle } = require('./bundle.service');
const loyalty = require('./loyalty.service');
const env = require('../config/env');
const { generateOpaqueToken, hashOpaqueToken } = require('../utils/tokens');
const idempotency = require('./guestIdempotency');
const inventory = require('./inventory.service');

const { ORDER_STATUSES, CANCELLATION_REASONS } = require('../models/order.model');

// Allowed forward transitions. 'cancelled' reachable from any non-terminal state.
const STATUS_FLOW = {
  pending: ['processing', 'shipped', 'cancelled'],
  processing: ['shipped', 'delivered', 'cancelled'],
  shipped: ['delivered', 'cancelled'],
  delivered: [],
  cancelled: [],
};

async function loadCartLines(userId, transaction, { lock = false } = {}) {
  // Placement locks the cart row first: a concurrent second submission of the
  // same cart waits here, then re-reads an emptied cart instead of creating a
  // duplicate order from lines it had already loaded.
  const cart = await db.Cart.findOne({ where: { user_id: userId }, transaction, ...(lock ? { lock: transaction.LOCK.UPDATE } : {}) });
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
 * Guest checkout has no server-side cart — the client submits the line
 * items it wants directly. Every price and stock fact is still re-read from
 * the database here; nothing from the request body is trusted for pricing.
 */
function normalizeGuestItems(items) {
  // A guest can submit arbitrary JSON, including the same variant twice. Fold
  // it before stock checks so two individually-valid lines cannot exceed stock.
  const quantities = new Map();
  for (const item of items) quantities.set(item.variant_id, (quantities.get(item.variant_id) || 0) + item.quantity);
  return [...quantities].map(([variant_id, quantity]) => ({ variant_id, quantity }));
}

async function loadGuestLines(items, transaction) {
  if (!items || !items.length) throw ApiError.badRequest('Your order has no items', 'cart_empty');
  const normalizedItems = normalizeGuestItems(items);
  const variantIds = normalizedItems.map((i) => i.variant_id);
  const variants = await db.ProductVariant.findAll({
    where: { id: { [Op.in]: variantIds } },
    include: [
      { model: db.Product, as: 'product', include: [{ model: db.Category, as: 'category' }] },
    ],
    transaction,
  });
  const variantMap = new Map(variants.map((v) => [v.id, v]));
  const resolvedItems = normalizedItems.map((i) => {
    const variant = variantMap.get(i.variant_id);
    if (!variant) throw ApiError.badRequest('A product in your order is no longer available', 'variant_unavailable');
    return { variant_id: i.variant_id, quantity: i.quantity, variant };
  });
  return { items: resolvedItems };
}

/** Duck-typed shipping address for ParcelMoover's delivery quote. */
function guestShippingAddress(guest) {
  return { city: guest.municipality, state: guest.province, country: 'Nepal' };
}

function totalShippingWeightKg(items) {
  const { defaultWeightKg } = parcelmoover.getConfiguration();
  // No product/variant weight columns currently exist. The configured default
  // is therefore a per-item weight, multiplied by quantity, never a package total.
  return Number(items.reduce((total, item) => {
    const configuredWeight = Number(item.variant?.weight_kg ?? item.variant?.product?.weight_kg);
    const unitWeight = Number.isFinite(configuredWeight) && configuredWeight > 0
      ? configuredWeight
      : defaultWeightKg;
    return total + unitWeight * item.quantity;
  }, 0).toFixed(3));
}

/**
 * Compute the money breakdown for a set of cart items.
 * Pure-ish: reads coupon/shipping/tax config but writes nothing.
 */
async function computeTotals({ userId, items, shippingAddress, parcelmooverDestinationId, couponCode, redeemPoints = 0 }, transaction) {
  // Sellable quantity is physical stock minus active reservations. Inside a
  // placement transaction the variants are already locked and reservations are
  // read with a locking read, so concurrent orders cannot both take the last unit.
  const availability = await inventory.availabilityFor(items.map((item) => item.variant), { transaction });
  const lines = items.map((item) => {
    const variant = item.variant;
    if (!variant || !variant.is_active) {
      throw ApiError.badRequest('A product in your cart is no longer available', 'variant_unavailable');
    }
    if (availability.get(variant.id).available < item.quantity) {
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
      compare_at_price: variant.compare_at_price == null ? null : Number(variant.compare_at_price),
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
    if (bundle.pairs > 0) {
      throw ApiError.badRequest(
        'Coupon codes cannot be combined with the Dashain offer.',
        'coupon_not_combinable_with_campaign'
      );
    }
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

  // No address yet (an early guest cart-stage preview) leaves delivery
  // unresolved. With an address, a failed/unconfigured carrier is an error;
  // never substitute a local or zero-cost delivery fallback.
  let shippingAmount = 0;
  let shippingRate = null;
  if (shippingAddress) {
    const quote = await parcelmoover.quote({
      destinationId: parcelmooverDestinationId,
      weightKg: totalShippingWeightKg(items),
    });
    shippingAmount = quote.amount;
    shippingRate = quote;
  }

  // No sales tax is charged on orders.
  const taxAmount = 0;

  const total = Number((discountedSubtotal + shippingAmount).toFixed(2));

  return {
    lines,
    subtotal,
    covers_qty: bundle.covers_qty,
    bundle_discount: bundleDiscount,
    campaign_active: bundle.campaign_active,
    campaign_code: bundle.campaign_code,
    campaign_label: bundle.campaign_label,
    free_items: bundle.free_items,
    coupon,
    coupon_discount: discount,
    points_redeemed: pointsToRedeem,
    points_discount: pointsDiscount,
    discount_amount: totalDiscount,
    shipping_amount: shippingAmount,
    shipping_rate: shippingRate,
    tax_amount: taxAmount,
    total_amount: total,
    advance_amount: env.payment.advanceAmount,
    remaining_due: Number(Math.max(total - env.payment.advanceAmount, 0).toFixed(2)),
  };
}

async function previewOrder(userId, { shipping_address_id, parcelmoover_destination_id, coupon_code, redeem_points }) {
  const { items } = await loadCartLines(userId);
  const shippingAddress = await requireOwnedAddress(userId, shipping_address_id);
  const totals = await computeTotals({
    userId,
    items,
    shippingAddress,
    parcelmooverDestinationId: parcelmoover_destination_id,
    couponCode: coupon_code,
    redeemPoints: redeem_points || 0,
  });
  const { lines, coupon, shipping_rate, ...rest } = totals;
  return {
    ...rest,
    coupon: coupon ? { code: coupon.code, description: coupon.description } : null,
    shipping_method: shipping_rate ? shipping_rate.service_type : null,
    courier: shipping_rate ? {
      provider: 'parcelmoover', destination_id: shipping_rate.destination.id,
      destination_name: shipping_rate.destination.name, service_type: shipping_rate.service_type,
      weight_kg: shipping_rate.weight_kg, base_charge: shipping_rate.base_charge,
      weight_surcharge: shipping_rate.weight_surcharge, rate_type: shipping_rate.rate_type,
      basis: shipping_rate.basis, valley: shipping_rate.valley,
    } : null,
    lines: lines.map((l) => ({
      variant_id: l.variant_id,
      name: l.product_name_snap,
      sku: l.sku_snap,
      unit_price: l.unit_price,
      compare_at_price: l.compare_at_price,
      quantity: l.quantity,
      line_total: l.line_total,
    })),
  };
}

/**
 * Shared order-creation tail used by both the authenticated and guest
 * placement paths — the ONE place that writes order items, decrements
 * stock, snapshots free promo items, opens status history, and creates the
 * payment confirmation row. `orderAttrs` differs (user_id + addresses vs.
 * guest_* fields), everything after that is identical.
 */
async function createOrderAndSideEffects({ orderAttrs, totals, transaction: t }) {
  const order = await db.Order.create(orderAttrs, { transaction: t });

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

  // Reserve, don't deduct: physical stock changes only when payment is
  // approved or COD is confirmed (inventory.commitForOrder).
  await inventory.reserveForOrder(order.id, totals.lines, t);

  // Snapshot free promotional items (e.g. the Dashain suction holder).
  // These carry no catalogue SKU and never touch inventory.
  if (totals.free_items.length) {
    await db.OrderPromoItem.bulkCreate(
      totals.free_items.map((item) => ({
        order_id: order.id,
        sku_snap: `PROMO-${item.type.toUpperCase()}`,
        name_snap: item.name,
        quantity: item.quantity,
        unit_price: item.price,
      })),
      { transaction: t }
    );
  }

  await db.OrderStatusHistory.create(
    { order_id: order.id, status: 'pending', note: orderAttrs.user_id ? 'Order placed' : 'Order placed (guest)' },
    { transaction: t }
  );

  await db.OrderPaymentConfirmation.create(
    { order_id: order.id, method: 'advance_qr', advance_amount: env.payment.advanceAmount, status: 'pending' },
    { transaction: t }
  );

  return order;
}

/** Re-lock variants and re-check stock inside a transaction; mutates each item's `.variant` in place. */
async function lockVariantsForItems(items, transaction) {
  const variantIds = items.map((i) => i.variant_id);
  const variants = await db.ProductVariant.findAll({
    where: { id: { [Op.in]: variantIds } },
    lock: transaction.LOCK.UPDATE,
    transaction,
  });
  const variantMap = new Map(variants.map((v) => [v.id, v]));
  for (const item of items) {
    const lockedVariant = variantMap.get(item.variant_id);
    if (lockedVariant) {
      // Keep the product+category eager-loaded by the caller (needed for the
      // name snapshot and the cover-bundle category check); only the locked
      // stock/price fields matter from the re-read.
      lockedVariant.product = item.variant?.product || null;
      item.variant = lockedVariant;
    }
    if (item.variant && !item.variant.product) {
      item.variant.product = await db.Product.findByPk(item.variant.product_id, {
        include: [{ model: db.Category, as: 'category' }],
        transaction,
      });
    }
  }
  return variantMap;
}

async function placeOrder(userId, payload) {
  const { shipping_address_id, billing_address_id, parcelmoover_destination_id, coupon_code, redeem_points } = payload;
  // Bookkeeping only; availability already ignores lapsed holds.
  await inventory.expireStale();

  return db.sequelize.transaction(inventory.STOCK_TX, async (t) => {
    const { cart, items } = await loadCartLines(userId, t, { lock: true });

    const shippingAddress = await requireOwnedAddress(userId, shipping_address_id, t);
    const billingAddress = billing_address_id
      ? await requireOwnedAddress(userId, billing_address_id, t)
      : shippingAddress;

    await lockVariantsForItems(items, t);

    const totals = await computeTotals(
      {
        userId,
        items,
        shippingAddress,
        parcelmooverDestinationId: parcelmoover_destination_id,
        couponCode: coupon_code,
        redeemPoints: redeem_points || 0,
      },
      t
    );

    const order = await createOrderAndSideEffects({
      orderAttrs: {
        order_number: generateOrderNumber(),
        user_id: userId,
        status: 'pending',
        subtotal_amount: totals.subtotal,
        discount_amount: totals.discount_amount,
        bundle_discount_amount: totals.bundle_discount,
        campaign_code: totals.campaign_code,
        campaign_name_snap: totals.campaign_label,
        tax_amount: totals.tax_amount,
        shipping_amount: totals.shipping_amount,
        courier_provider: 'parcelmoover',
        courier_destination_id: totals.shipping_rate.destination.id,
        courier_destination_name: totals.shipping_rate.destination.name,
        courier_service_type: totals.shipping_rate.service_type,
        courier_weight_kg: totals.shipping_rate.weight_kg,
        courier_base_charge: totals.shipping_rate.base_charge,
        courier_weight_surcharge: totals.shipping_rate.weight_surcharge,
        courier_delivery_charge: totals.shipping_amount,
        courier_rate_basis: totals.shipping_rate.basis,
        courier_valley: totals.shipping_rate.valley,
        total_amount: totals.total_amount,
        coupon_id: totals.coupon ? totals.coupon.id : null,
        shipping_address_id: shippingAddress.id,
        billing_address_id: billingAddress.id,
      },
      totals,
      transaction: t,
    });

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
  { model: db.OrderPromoItem, as: 'promoItems' },
  { model: db.Address, as: 'shippingAddress' },
  { model: db.Address, as: 'billingAddress' },
  { model: db.Coupon, as: 'coupon' },
  { model: db.OrderPaymentConfirmation, as: 'paymentConfirmation', include: [{ model: db.Staff, as: 'reviewedByStaff', attributes: ['id', 'name'] }] },
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

/** Shared pending/payment-state eligibility check for customer and guest self-cancellation. */
async function assertSelfCancellable(order, transaction) {
  if (order.status !== 'pending') {
    throw ApiError.badRequest('Only pending orders can be cancelled.', 'order_not_cancellable');
  }
  const payment = await db.OrderPaymentConfirmation.findOne({
    where: { order_id: order.id }, lock: transaction.LOCK.UPDATE, transaction,
  });
  const cancellablePayment = !payment || ['pending', 'proof_uploaded', 'rejected', 'cod_pending'].includes(payment.status);
  if (!cancellablePayment) {
    throw ApiError.badRequest('This order can no longer be cancelled after payment confirmation.', 'order_not_cancellable');
  }
}

/** Customer cancellation is intentionally restricted to unconfirmed pending orders. */
async function cancelUserOrder(userId, orderId) {
  return db.sequelize.transaction(async (transaction) => {
    const order = await db.Order.findOne({
      where: { id: orderId, user_id: userId },
      lock: transaction.LOCK.UPDATE,
      transaction,
    });
    if (!order) throw ApiError.notFound('Order not found', 'order_not_found');
    await assertSelfCancellable(order, transaction);
    return transitionOrderStatus(order.id, { status: 'cancelled', note: 'Cancelled by customer before payment confirmation', cancellationReason: 'customer' }, null, transaction);
  });
}

/* ---------------------------- Guest checkout --------------------------- */

async function previewGuestOrder({ items, guest, coupon_code }) {
  if (coupon_code) {
    throw ApiError.badRequest('Coupon codes require an account. Sign in to use one.', 'coupon_requires_account');
  }
  const { items: lines } = await loadGuestLines(items);
  const shippingAddress = guest?.municipality ? guestShippingAddress(guest) : undefined;
  const totals = await computeTotals({ userId: null, items: lines, shippingAddress, parcelmooverDestinationId: guest?.parcelmoover_destination_id, couponCode: undefined, redeemPoints: 0 });
  const { lines: totalsLines, coupon, shipping_rate, ...rest } = totals;
  return {
    ...rest,
    coupon: null,
    shipping_method: shipping_rate ? shipping_rate.service_type : null,
    courier: shipping_rate ? {
      provider: 'parcelmoover', destination_id: shipping_rate.destination.id,
      destination_name: shipping_rate.destination.name, service_type: shipping_rate.service_type,
      weight_kg: shipping_rate.weight_kg, base_charge: shipping_rate.base_charge,
      weight_surcharge: shipping_rate.weight_surcharge, rate_type: shipping_rate.rate_type,
      basis: shipping_rate.basis, valley: shipping_rate.valley,
    } : null,
    lines: totalsLines.map((l) => ({
      variant_id: l.variant_id,
      name: l.product_name_snap,
      sku: l.sku_snap,
      unit_price: l.unit_price,
      compare_at_price: l.compare_at_price,
      quantity: l.quantity,
      line_total: l.line_total,
    })),
  };
}

/** Resolve a raw guest token to its order id via the stored hash. Returns null, never throws, for an unknown token. */
async function resolveGuestToken(token, transaction) {
  const tokenHash = hashOpaqueToken(token);
  const record = await db.GuestOrderToken.findOne({ where: { token_hash: tokenHash }, transaction });
  return record ? record.order_id : null;
}

const isIdempotencyKeyCollision = (error) => error?.name === 'SequelizeUniqueConstraintError'
  && /uq_guest_idem_key/.test(error.parent?.sqlMessage || error.original?.sqlMessage || '');

/**
 * Returns the committed result for a repeated Idempotency-Key. Same payload:
 * the original order plus its recovered guest token. Different payload: 409.
 * An expired reservation is purged and reported so the caller can retry once.
 */
async function replayGuestOrder({ rawKey, keyHash, fingerprint }) {
  const record = await db.GuestOrderIdempotency.findOne({ where: { key_hash: keyHash } });
  if (!record) return { retry: true };
  if (record.expires_at <= new Date()) {
    await db.GuestOrderIdempotency.destroy({ where: { id: record.id, expires_at: { [Op.lte]: new Date() } } });
    return { retry: true };
  }
  if (record.request_fingerprint !== fingerprint) {
    throw new ApiError(409, 'This checkout request has already been used for a different order attempt.', 'idempotency_key_reused');
  }
  const token = record.replay_token_sealed
    ? idempotency.openGuestToken(record.replay_token_sealed, { rawKey, keyHash, secret: env.guestReplaySecret })
    : null;
  const order = record.order_id ? await db.Order.findOne({ where: { id: record.order_id, user_id: null }, include: orderInclude }) : null;
  if (!order || !token) {
    throw new ApiError(409, 'This order was already placed. Please use the order link you received, or contact support.', 'idempotency_replay_unavailable');
  }
  return { order: shapeOrder(order), guest_token: token, replayed: true };
}

/**
 * Idempotent guest placement. The reservation row is the FIRST write in the
 * same transaction as the order, keyed by a UNIQUE key_hash:
 * - a concurrent request with the same key blocks on InnoDB's unique-index
 *   lock until this transaction ends, then either collides (commit: replay
 *   the committed result) or becomes the creator (rollback);
 * - any failure rolls the reservation back with the order, so the key is
 *   never left half-used and a retry re-executes cleanly.
 * The database enforces this, so it holds across processes and instances.
 */
async function placeGuestOrder(payload, { idempotencyKey } = {}) {
  const rawKey = idempotency.parseIdempotencyKey(idempotencyKey);
  const keyHash = idempotency.hashIdempotencyKey(rawKey);
  const fingerprint = idempotency.fingerprintGuestRequest(payload);
  // Opportunistic retention: replay records live 24 hours; lapsed stock holds are marked expired.
  await db.GuestOrderIdempotency.destroy({ where: { expires_at: { [Op.lte]: new Date() } } });
  await inventory.expireStale();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await createGuestOrder(payload, { rawKey, keyHash, fingerprint });
    } catch (error) {
      if (!isIdempotencyKeyCollision(error)) throw error;
      const replay = await replayGuestOrder({ rawKey, keyHash, fingerprint });
      if (!replay.retry) return replay;
    }
  }
  throw new ApiError(409, 'This checkout request is already being processed. Please try again.', 'idempotency_in_progress');
}

async function createGuestOrder({ items, guest }, { rawKey, keyHash, fingerprint }) {
  return db.sequelize.transaction(inventory.STOCK_TX, async (t) => {
    const reservation = await db.GuestOrderIdempotency.create(
      { key_hash: keyHash, request_fingerprint: fingerprint, expires_at: new Date(Date.now() + idempotency.REPLAY_TTL_MS) },
      { transaction: t }
    );
    const { items: lines } = await loadGuestLines(items, t);
    const shippingAddress = guestShippingAddress(guest);
    await lockVariantsForItems(lines, t);

    const totals = await computeTotals(
      { userId: null, items: lines, shippingAddress, parcelmooverDestinationId: guest.parcelmoover_destination_id, couponCode: undefined, redeemPoints: 0 },
      t
    );

    const order = await createOrderAndSideEffects({
      orderAttrs: {
        order_number: generateOrderNumber(),
        user_id: null,
        guest_name: guest.name,
        guest_phone: guest.phone,
        guest_province: guest.province,
        guest_district: guest.district,
        guest_municipality: guest.municipality,
        guest_area: guest.area,
        guest_landmark: guest.landmark || null,
        guest_delivery_notes: guest.notes || null,
        guest_latitude: guest.latitude ?? null,
        guest_longitude: guest.longitude ?? null,
        status: 'pending',
        subtotal_amount: totals.subtotal,
        discount_amount: totals.discount_amount,
        bundle_discount_amount: totals.bundle_discount,
        campaign_code: totals.campaign_code,
        campaign_name_snap: totals.campaign_label,
        tax_amount: totals.tax_amount,
        shipping_amount: totals.shipping_amount,
        courier_provider: 'parcelmoover',
        courier_destination_id: totals.shipping_rate.destination.id,
        courier_destination_name: totals.shipping_rate.destination.name,
        courier_service_type: totals.shipping_rate.service_type,
        courier_weight_kg: totals.shipping_rate.weight_kg,
        courier_base_charge: totals.shipping_rate.base_charge,
        courier_weight_surcharge: totals.shipping_rate.weight_surcharge,
        courier_delivery_charge: totals.shipping_amount,
        courier_rate_basis: totals.shipping_rate.basis,
        courier_valley: totals.shipping_rate.valley,
        total_amount: totals.total_amount,
        coupon_id: null,
        shipping_address_id: null,
        billing_address_id: null,
      },
      totals,
      transaction: t,
    });

    // High-entropy random token; only its sha256 hash is ever stored.
    const { raw, hash } = generateOpaqueToken();
    await db.GuestOrderToken.create({ order_id: order.id, token_hash: hash }, { transaction: t });
    await reservation.update({
      order_id: order.id,
      replay_token_sealed: idempotency.sealGuestToken(raw, { rawKey, keyHash, secret: env.guestReplaySecret }),
    }, { transaction: t });

    const shaped = await db.Order.findOne({ where: { id: order.id }, include: orderInclude, transaction: t });
    return { order: shapeOrder(shaped), guest_token: raw, replayed: false };
  });
}

/** Loads a guest order by its raw access token. Never reveals whether an unknown token differs from a customer's order — both are 404. */
async function getGuestOrder(token, transaction) {
  const orderId = await resolveGuestToken(token, transaction);
  if (!orderId) throw ApiError.notFound('Order not found', 'order_not_found');
  const order = await db.Order.findOne({
    where: { id: orderId, user_id: null },
    include: orderInclude,
    transaction,
  });
  if (!order) throw ApiError.notFound('Order not found', 'order_not_found');
  return shapeOrder(order);
}

async function cancelGuestOrder(token) {
  return db.sequelize.transaction(async (transaction) => {
    const orderId = await resolveGuestToken(token, transaction);
    if (!orderId) throw ApiError.notFound('Order not found', 'order_not_found');
    const order = await db.Order.findOne({
      where: { id: orderId, user_id: null },
      lock: transaction.LOCK.UPDATE,
      transaction,
    });
    if (!order) throw ApiError.notFound('Order not found', 'order_not_found');
    await assertSelfCancellable(order, transaction);
    return transitionOrderStatus(order.id, { status: 'cancelled', note: 'Cancelled by guest before payment confirmation', cancellationReason: 'guest' }, null, transaction);
  });
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

/**
 * Staff review target for an uploaded payment proof. Display only: an overdue
 * proof keeps its hold and its order; nothing is approved, rejected or
 * cancelled because of it.
 */
function reviewSlaMs() {
  const hours = Number(process.env.PAYMENT_PROOF_REVIEW_SLA_HOURS);
  return (Number.isFinite(hours) && hours > 0 ? hours : 72) * 60 * 60 * 1000;
}

/** proof_uploaded (unchanged since the upload) for longer than the review SLA. */
function isReviewOverdue(confirmation, now = new Date()) {
  return Boolean(confirmation && confirmation.status === 'proof_uploaded' && confirmation.updated_at
    && now.getTime() - new Date(confirmation.updated_at).getTime() > reviewSlaMs());
}

async function adminGetOrder(orderId, transaction) {
  const order = await db.Order.findByPk(orderId, {
    include: [...orderInclude, { model: db.User, as: 'user', attributes: ['id', 'name', 'email'] }],
    transaction,
  });
  if (!order) throw ApiError.notFound('Order not found', 'order_not_found');
  const shaped = shapeOrder(order);
  if (shaped.paymentConfirmation) shaped.paymentConfirmation.review_overdue = isReviewOverdue(shaped.paymentConfirmation);
  return shaped;
}

/**
 * The one place order status changes. cancellationReason (see
 * CANCELLATION_REASONS) records who or what cancelled; staff changes default to
 * 'staff'.
 */
async function transitionOrderStatus(orderId, { status, note, cancellationReason }, staffId, transaction) {
  if (!ORDER_STATUSES.includes(status)) {
    throw ApiError.badRequest('Unknown status', 'bad_status');
  }
  const reason = status === 'cancelled' ? cancellationReason || (staffId ? 'staff' : null) : null;
  if (reason && !CANCELLATION_REASONS.includes(reason)) throw new Error(`Unknown cancellation reason: ${reason}`);
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

    // New checkout orders receive a payment-confirmation record. Fulfilment
    // cannot progress until that record has been verified. Orders created
    // before this feature intentionally have no record and retain their
    // historical workflow rather than being retroactively blocked.
    if (['processing', 'shipped', 'delivered'].includes(status)) {
      const payment = await db.OrderPaymentConfirmation.findOne({
        where: { order_id: order.id },
        lock: t.LOCK.UPDATE,
        transaction: t,
      });
      const confirmed = payment && (
        (payment.method === 'advance_qr' && payment.status === 'approved') ||
        (payment.method === 'whatsapp_cod' && payment.status === 'cod_confirmed')
      );
      if (payment && !confirmed) {
        throw ApiError.forbidden(
          'Payment confirmation must be approved before this order can be processed.',
          'payment_confirmation_required'
        );
      }
      // Confirmation commits the reserved stock in the same transaction; never
      // let fulfilment start on stock that is still only held.
      await inventory.assertCommitted(order.id, t);
    }

    if (status === 'cancelled') {
      // Held stock is released (physical unchanged); committed stock is
      // restocked exactly once. Legacy orders placed before reservations
      // existed were deducted at placement and are restocked from their items.
      const { hadReservations } = await inventory.releaseForOrder(order.id, t);
      if (!hadReservations) await inventory.restockLegacyItems(order.items, t);
    }

    order.status = status;
    if (reason) order.cancellation_reason = reason;
    await order.save({ transaction: t });
    await db.OrderStatusHistory.create(
      { order_id: order.id, status, changed_by_staff_id: staffId || null, note: note || null },
      { transaction: t }
    );

    // Award loyalty points once delivered. Guest orders have no account to
    // credit — loyalty_transactions.user_id is NOT NULL, so this must skip them.
    if (status === 'delivered' && order.user_id) {
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
  normalizeGuestItems,
  computeTotals,
  previewOrder,
  placeOrder,
  listUserOrders,
  getUserOrder,
  cancelUserOrder,
  previewGuestOrder,
  placeGuestOrder,
  getGuestOrder,
  cancelGuestOrder,
  adminListOrders,
  adminGetOrder,
  reviewSlaMs,
  isReviewOverdue,
  transitionOrderStatus,
  updateOrderStatus,
};
