'use strict';

const { z, id } = require('./common');

const categorySlug = z.string().trim().min(1).max(100).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

const createReviewSchema = z.object({
  product_id: id,
  rating: z.coerce.number().int().min(1).max(5),
  title: z.string().trim().max(150).optional(),
  body: z.string().trim().max(5000).optional(),
});

const listReviewsQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

const publicReviewsQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(12),
  category: categorySlug.optional(),
  rating: z.coerce.number().int().min(1).max(5).optional(),
});

const moderateReviewSchema = z.object({
  status: z.enum(['approved', 'rejected']),
});

const adminListReviewsQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  status: z.enum(['pending', 'approved', 'rejected']).optional(),
});

module.exports = {
  createReviewSchema,
  listReviewsQuery,
  publicReviewsQuery,
  moderateReviewSchema,
  adminListReviewsQuery,
};
