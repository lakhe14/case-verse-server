'use strict';

/**
 * What an order looks like outside the staff area.
 *
 * Customers (their own account), guests (their secure link) and the public
 * tracker (order number + phone) all get an allow-listed copy of the order:
 * never staff notes, staff identities, payment-proof file names, coupon
 * internals, legacy map pins or database ids beyond what that audience
 * already needs to act on the order.
 *
 * Status wording is not decided here — the storefront maps these raw states
 * (order status, cancellation reason, payment method/status) in one place.
 */

const num = (value) => (value == null ? null : Number(value));

/** "10-digit Nepal mobile" from +977 98…, 977-98…, 098…, 98… with spaces or dashes; null otherwise. */
function normalizeNepalPhone(raw) {
  let digits = String(raw || '').replace(/[\s\-().]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  if (!/^\d+$/.test(digits)) return null;
  if (digits.startsWith('977') && digits.length === 13) digits = digits.slice(3);
  if (digits.startsWith('0') && digits.length === 11) digits = digits.slice(1);
  return /^9\d{9}$/.test(digits) ? digits : null;
}

/** Phone number the order is delivered to (guest details, or the signed-in customer's shipping address). */
function orderPhone(order) {
  return order.user_id ? order.shippingAddress?.phone : order.guest_phone;
}

/** Model label of an order line from its variant's attribute values ("iPhone 15 Pro"); null when unknown. */
function lineModel(item) {
  const values = (item.variant?.attributeValues || []).map((av) => av.value).filter(Boolean);
  return values.length ? values.join(' / ') : null;
}

/**
 * Money the order still expects at the door. An advance counts only once
 * staff have verified it; a COD order has no advance at all.
 */
function paymentSummary(order) {
  const payment = order.paymentConfirmation;
  const total = num(order.total_amount) || 0;
  if (!payment) return { method: null, advance_paid: 0, remaining_cod: total };
  const advancePaid = payment.method === 'advance_qr' && payment.status === 'approved' ? num(payment.advance_amount) || 0 : 0;
  return {
    method: payment.method,
    advance_amount: num(payment.advance_amount),
    advance_paid: advancePaid,
    remaining_cod: Number(Math.max(total - advancePaid, 0).toFixed(2)),
  };
}

function deliveryView(order, { full }) {
  if (order.user_id) {
    const a = order.shippingAddress;
    if (!a) return null;
    return {
      name: a.recipient_name,
      phone: full ? a.phone : undefined,
      // Public tracking shows the area only; the owner sees the full address.
      lines: (full ? [a.line1, a.line2, a.city, a.state, a.country] : [a.city, a.state]).filter(Boolean),
      landmark: null,
    };
  }
  return {
    name: order.guest_name,
    phone: full ? order.guest_phone : undefined,
    lines: (full
      ? [order.guest_area, order.guest_municipality, order.guest_district, order.guest_province]
      : [order.guest_municipality, order.guest_district]).filter(Boolean),
    landmark: full ? order.guest_landmark || null : null,
  };
}

/**
 * @param order plain order with orderInclude associations
 * @param audience 'customer' (own account) or 'guest' (secure link): the
 *   owner, with the ids its actions use and full delivery details; or
 *   'tracking' (order number + phone): a summary with no ids.
 */
function customerOrderView(order, audience) {
  const o = order.get ? order.get({ plain: true }) : order;
  const full = audience !== 'tracking';
  const withIds = full;
  const payment = o.paymentConfirmation;
  return {
    ...(withIds ? { id: o.id } : {}),
    order_number: o.order_number,
    placed_at: o.placed_at,
    status: o.status,
    cancellation_reason: o.cancellation_reason || null,
    is_guest: !o.user_id,
    items: (o.items || []).map((it) => ({
      ...(withIds ? { id: it.id } : {}),
      product_name_snap: it.product_name_snap,
      sku_snap: full ? it.sku_snap : undefined,
      model: lineModel(it),
      quantity: it.quantity,
      unit_price: num(it.unit_price),
      line_total: num(it.line_total),
      // Account pages link reviews to the product; the slug is public anyway.
      product: it.variant?.product ? { id: withIds ? it.variant.product.id : undefined, slug: it.variant.product.slug } : null,
    })),
    promoItems: (o.promoItems || []).map((p, index) => ({ id: index + 1, name_snap: p.name_snap, quantity: p.quantity })),
    subtotal_amount: num(o.subtotal_amount),
    bundle_discount_amount: num(o.bundle_discount_amount),
    discount_amount: num(o.discount_amount),
    shipping_amount: num(o.shipping_amount),
    total_amount: num(o.total_amount),
    campaign_name_snap: o.campaign_name_snap || null,
    coupon_code: o.coupon?.code || null,
    courier_destination_name: o.courier_destination_name || null,
    delivery: deliveryView(o, { full }),
    // Status changes only: when and what. Staff notes and staff ids stay internal.
    statusHistory: (o.statusHistory || []).map((h, index) => ({ id: index + 1, status: h.status, changed_at: h.changed_at })),
    paymentConfirmation: payment
      ? {
          ...(withIds ? { id: payment.id } : {}),
          method: payment.method,
          status: payment.status,
          advance_amount: num(payment.advance_amount),
          // The rejection reason is written for the customer; other staff notes are not.
          admin_note: payment.status === 'rejected' ? payment.admin_note || null : null,
          updated_at: payment.updated_at,
        }
      : null,
    payment_summary: paymentSummary(o),
  };
}

module.exports = { normalizeNepalPhone, orderPhone, lineModel, paymentSummary, customerOrderView };
