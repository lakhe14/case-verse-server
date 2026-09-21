'use strict';

const { z, shortText, id } = require('./common');

const listProductsQuery = z.object({
  category: z.string().trim().max(100).optional(),
  q: z.string().trim().max(120).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(60).default(20),
  sort: z.enum(['newest', 'oldest', 'name_asc', 'name_desc']).default('newest'),
});

const slugParam = z.object({ slug: z.string().trim().min(1).max(220) });

/* ------------------------------- Admin ------------------------------- */

const variantInput = z.object({
  sku: shortText(64),
  price: z.coerce.number().nonnegative(),
  stock_quantity: z.coerce.number().int().min(0),
  is_active: z.boolean().default(true),
  attributes: z
    .array(z.object({ attribute_id: id, value: shortText(150) }))
    .default([]),
});

const createProductSchema = z.object({
  category_id: id,
  name: shortText(200),
  slug: z.string().trim().max(220).optional(),
  description: z.string().trim().max(20000).optional().nullable(),
  base_price: z.coerce.number().nonnegative(),
  status: z.enum(['active', 'inactive', 'draft']).default('active'),
  variants: z.array(variantInput).optional(),
});

const updateProductSchema = createProductSchema.partial().omit({ variants: true });

const createVariantSchema = variantInput;
const updateVariantSchema = variantInput.partial();

const createCategorySchema = z.object({
  name: shortText(100),
  slug: z.string().trim().max(100).optional(),
  attribute_ids: z.array(id).default([]),
});

const attributeSchema = z.object({ name: shortText(80) });

const setCategoryAttributesSchema = z.object({
  attribute_ids: z.array(id),
});

module.exports = {
  listProductsQuery,
  slugParam,
  createProductSchema,
  updateProductSchema,
  createVariantSchema,
  updateVariantSchema,
  createCategorySchema,
  attributeSchema,
  setCategoryAttributesSchema,
};
