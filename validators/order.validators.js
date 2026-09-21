'use strict';

const { z, id, shortText } = require('./common');
const { ORDER_STATUSES } = require('../models/order.model');

const previewSchema = z.object({
  shipping_address_id: id,
  coupon_code: z.string().trim().max(40).optional(),
  redeem_points: z.coerce.number().int().min(0).default(0),
});

const placeOrderSchema = z.object({
  shipping_address_id: id,
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
};
