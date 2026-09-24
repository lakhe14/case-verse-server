'use strict';

const { z, id, shortText, nepaliPhone } = require('./common');
const { ORDER_STATUSES } = require('../models/order.model');

const guestItemSchema = z.object({
  variant_id: id,
  quantity: z.coerce.number().int().min(1).max(20),
});
const guestItemsSchema = z.array(guestItemSchema).min(1).max(30);

const guestInfoSchema = z.object({
  name: shortText(120),
  phone: nepaliPhone,
  province: shortText(100),
  district: shortText(100),
  municipality: shortText(150),
  area: shortText(255),
  landmark: z.string().trim().max(255).optional(),
  notes: z.string().trim().max(500).optional(),
  parcelmoover_destination_id: z.string().trim().min(1).max(100),
});

const guestPreviewSchema = z.object({
  items: guestItemsSchema,
  // Optional: an early cart-stage preview (before the guest has filled in
  // delivery details) skips the shipping estimate but still prices the
  // Dashain bundle correctly. The checkout-page preview sends this to get
  // a real shipping figure.
  guest: guestInfoSchema.partial().optional(),
});

const guestPlaceOrderSchema = z.object({
  items: guestItemsSchema,
  guest: guestInfoSchema,
});

const guestTokenParam = z.object({ token: z.string().trim().min(20).max(200) });

const previewSchema = z.object({
  shipping_address_id: id,
  parcelmoover_destination_id: z.string().trim().min(1).max(100),
  coupon_code: z.string().trim().max(40).optional(),
  redeem_points: z.coerce.number().int().min(0).default(0),
});

const placeOrderSchema = z.object({
  shipping_address_id: id,
  parcelmoover_destination_id: z.string().trim().min(1).max(100),
  // Optional: billing defaults to the shipping address when omitted.
  billing_address_id: id.optional(),
  coupon_code: z.string().trim().max(40).optional(),
  redeem_points: z.coerce.number().int().min(0).default(0),
});

const listOrdersQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  status: z.enum(ORDER_STATUSES).optional(),
  q: z.string().trim().max(30).optional(),
});

const updateStatusSchema = z.object({
  status: z.enum(ORDER_STATUSES),
  note: z.string().trim().max(255).optional(),
});

const validateCouponSchema = z.object({
  code: shortText(40),
  subtotal: z.coerce.number().nonnegative(),
});

module.exports = {
  previewSchema,
  placeOrderSchema,
  listOrdersQuery,
  updateStatusSchema,
  validateCouponSchema,
  guestPreviewSchema,
  guestPlaceOrderSchema,
  guestTokenParam,
};
