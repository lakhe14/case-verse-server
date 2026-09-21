'use strict';

const { z, shortText } = require('./common');

const createAddressSchema = z.object({
  label: z.string().trim().max(50).optional(),
  recipient_name: shortText(120),
  phone: shortText(20),
  line1: shortText(255),
  line2: z.string().trim().max(255).optional().nullable(),
  city: shortText(100),
  state: z.string().trim().max(100).optional().nullable(),
  postal_code: z.string().trim().max(20).optional().nullable(),
  country: z.string().trim().max(100).default('Nepal'),
  is_default: z.boolean().optional(),
});

// All fields optional for PATCH-style updates.
const updateAddressSchema = createAddressSchema.partial();

module.exports = { createAddressSchema, updateAddressSchema };
