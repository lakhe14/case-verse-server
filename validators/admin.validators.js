'use strict';

const { z, email, password, shortText, id } = require('./common');

/* Coupons */
const couponBase = z.object({
  code: shortText(40),
  description: z.string().trim().max(255).optional().nullable(),
  discount_type: z.enum(['percentage', 'fixed']),
  discount_value: z.coerce.number().positive(),
  min_order_amount: z.coerce.number().min(0),
  // Absent / null means "unlimited" — a valid non-numeric choice, so optional.
  usage_limit_total: z.coerce.number().int().positive().optional().nullable(),
  usage_limit_per_user: z.coerce.number().int().positive().optional().nullable(),
  starts_at: z.coerce.date().optional().nullable(),
  ends_at: z.coerce.date().optional().nullable(),
  is_active: z.boolean().default(true),
});
const createCouponSchema = couponBase;
const updateCouponSchema = couponBase.partial();

/* Staff & roles */
const createStaffSchema = z.object({
  name: shortText(120),
  email,
  password,
  role_id: id,
});
const updateStaffSchema = z.object({
  name: shortText(120).optional(),
  password: password.optional(),
  role_id: id.optional(),
  is_active: z.boolean().optional(),
});
const createRoleSchema = z.object({
  name: shortText(50),
  permissionKeys: z.array(z.string()).default([]),
});
const setRolePermissionsSchema = z.object({
  permissionKeys: z.array(z.string()),
});

/* Settings */
const shippingRatesSchema = z.object({
  rates: z.array(
    z.object({
      id: id.optional(),
      zone_name: shortText(100),
      method_name: shortText(100),
      cost: z.coerce.number().min(0),
      free_above_amount: z.coerce.number().min(0).optional().nullable(),
      is_active: z.boolean().default(true),
    })
  ),
});
const generalSettingsSchema = z.record(z.string().max(80), z.string().max(500));

/* Analytics */
const dashboardQuery = z.object({
  period_days: z.coerce.number().int().min(1).max(365).default(30),
});
const salesQuery = z.object({
  granularity: z.enum(['day', 'week', 'month']).default('day'),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
const topProductsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

const paymentQueueQuery = z.object({
  status: z.enum(['pending', 'proof_uploaded', 'approved', 'rejected', 'cod_pending', 'cod_confirmed']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
const paymentReviewSchema = z.object({
  note: z.string().trim().max(500).optional(),
});

module.exports = {
  createCouponSchema,
  updateCouponSchema,
  createStaffSchema,
  updateStaffSchema,
  createRoleSchema,
  setRolePermissionsSchema,
  shippingRatesSchema,
  generalSettingsSchema,
  dashboardQuery,
  salesQuery,
  topProductsQuery,
  paymentQueueQuery,
  paymentReviewSchema,
};
