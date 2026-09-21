'use strict';

const { Op } = require('sequelize');
const db = require('../models');
const ApiError = require('../utils/ApiError');

/**
 * Public-safe reviewer name: first name + last initial ("Priya S."). Never the
 * full name. Single-word names are returned as-is; blank names fall back.
 */
function publicReviewerName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'A customer';
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
}

/** Fields safe to expose on public review endpoints — no email/phone/order data. */
function shapePublicReview(review) {
  return {
    id: review.id,
    rating: review.rating,
    title: review.title,
    body: review.body,
    reviewer_name: publicReviewerName(review.user?.name),
    product: review.product
      ? { name: review.product.name, slug: review.product.slug }
      : null,
    created_at: review.created_at,
  };
}

/**
 * Find the newest order_item for `productId` bought by `userId`. When
 * `deliveredOnly` is set, only order_items whose order has been delivered count.
 */
function findPurchaseOrderItem(userId, productId, { deliveredOnly = false } = {}) {
  const orderWhere = { user_id: userId };
  if (deliveredOnly) orderWhere.status = 'delivered';
  return db.OrderItem.findOne({
    include: [
      { model: db.ProductVariant, as: 'variant', where: { product_id: productId }, required: true },
      { model: db.Order, as: 'order', where: orderWhere, required: true, attributes: ['id', 'status'] },
    ],
    order: [['id', 'DESC']],
  });
}

function shapeOwnReview(review) {
  if (!review) return null;
  return {
    id: review.id,
    rating: review.rating,
    title: review.title,
    body: review.body,
    status: review.status,
    created_at: review.created_at,
  };
}

/**
 * Create a review. Requires a *verified, delivered* purchase: the user must have
 * an order_item for this product in one of their `delivered` orders. Links the
 * newest such order_item. New reviews are always created as `pending`.
 */
async function createReview(userId, { product_id, rating, title, body }) {
  const product = await db.Product.findByPk(product_id);
  if (!product) throw ApiError.notFound('Product not found', 'product_not_found');

  const existing = await db.Review.findOne({ where: { user_id: userId, product_id } });
  if (existing) throw ApiError.conflict('You have already reviewed this product', 'already_reviewed');

  const orderItem = await findPurchaseOrderItem(userId, product_id, { deliveredOnly: true });
  if (!orderItem) {
    const purchasedButNotDelivered = await findPurchaseOrderItem(userId, product_id);
    throw ApiError.forbidden(
      purchasedButNotDelivered
        ? 'You can review this product once your order has been delivered'
        : 'You can only review products you have purchased',
      'delivered_purchase_required'
    );
  }

  const review = await db.Review.create({
    product_id,
    user_id: userId,
    order_item_id: orderItem.id,
    rating,
    title: title || null,
    body: body || null,
    status: 'pending',
  });
  return review;
}

/**
 * Whether `userId` may review `productId` right now, and their existing review
 * if they have one. Drives the storefront "Write a review" section.
 */
async function getReviewEligibility(userId, productId) {
  const product = await db.Product.findByPk(productId);
  if (!product) throw ApiError.notFound('Product not found', 'product_not_found');

  const existing = await db.Review.findOne({ where: { user_id: userId, product_id: productId } });
  const purchased = await findPurchaseOrderItem(userId, productId);
  const delivered = purchased
    ? await findPurchaseOrderItem(userId, productId, { deliveredOnly: true })
    : null;

  return {
    has_purchased: !!purchased,
    has_delivered_purchase: !!delivered,
    already_reviewed: !!existing,
    can_review: !!delivered && !existing,
    review: shapeOwnReview(existing),
  };
}

async function listApprovedForProduct(productId, { page = 1, limit = 10 } = {}) {
  const { rows, count } = await db.Review.findAndCountAll({
    where: { product_id: productId, status: 'approved' },
    include: [{ model: db.User, as: 'user', attributes: ['id', 'name'] }],
    order: [['created_at', 'DESC']],
    limit,
    offset: (page - 1) * limit,
  });

  const agg = await db.Review.findAll({
    where: { product_id: productId, status: 'approved' },
    attributes: [
      [db.Sequelize.fn('AVG', db.Sequelize.col('rating')), 'avg'],
      [db.Sequelize.fn('COUNT', db.Sequelize.col('id')), 'count'],
    ],
    raw: true,
  });

  return {
    data: rows.map(shapePublicReview),
    summary: {
      average: agg[0].avg ? Number(Number(agg[0].avg).toFixed(2)) : null,
      count: Number(agg[0].count || 0),
    },
    pagination: { page, limit, total: count, pages: Math.ceil(count / limit) },
  };
}

/**
 * Every approved review across the whole catalogue, newest first. Public — no
 * auth. Optional `category` (a category slug) and `rating` (minimum stars).
 */
async function listApprovedPublic({ page = 1, limit = 12, category, rating } = {}) {
  const where = { status: 'approved' };
  if (rating) where.rating = { [Op.gte]: rating };

  const categoryInclude = {
    model: db.Category,
    as: 'category',
    attributes: ['slug', 'name'],
    required: !!category,
  };
  if (category) categoryInclude.where = { slug: category };

  const { rows, count } = await db.Review.findAndCountAll({
    where,
    include: [
      { model: db.User, as: 'user', attributes: ['name'] },
      {
        model: db.Product,
        as: 'product',
        attributes: ['id', 'name', 'slug'],
        required: true,
        include: [categoryInclude],
      },
    ],
    order: [['created_at', 'DESC']],
    limit,
    offset: (page - 1) * limit,
    distinct: true,
  });

  return {
    data: rows.map(shapePublicReview),
    pagination: { page, limit, total: count, pages: Math.ceil(count / limit) },
  };
}

async function listMine(userId, { page = 1, limit = 20 } = {}) {
  const { rows, count } = await db.Review.findAndCountAll({
    where: { user_id: userId },
    include: [{ model: db.Product, as: 'product', attributes: ['id', 'name', 'slug'] }],
    order: [['created_at', 'DESC']],
    limit,
    offset: (page - 1) * limit,
  });
  return { data: rows, pagination: { page, limit, total: count, pages: Math.ceil(count / limit) } };
}

async function adminList({ page = 1, limit = 20, status } = {}) {
  const where = {};
  if (status) where.status = status;
  const { rows, count } = await db.Review.findAndCountAll({
    where,
    include: [
      { model: db.User, as: 'user', attributes: ['id', 'name', 'email'] },
      { model: db.Product, as: 'product', attributes: ['id', 'name', 'slug'] },
    ],
    order: [['created_at', 'DESC']],
    limit,
    offset: (page - 1) * limit,
  });
  return { data: rows, pagination: { page, limit, total: count, pages: Math.ceil(count / limit) } };
}

async function moderate(reviewId, status) {
  const review = await db.Review.findByPk(reviewId);
  if (!review) throw ApiError.notFound('Review not found', 'review_not_found');
  review.status = status;
  await review.save();
  return review;
}

module.exports = {
  createReview,
  getReviewEligibility,
  listApprovedForProduct,
  listApprovedPublic,
  listMine,
  adminList,
  moderate,
};
