'use strict';

const express = require('express');
const validate = require('../middleware/validate');
const { requireAuth, requireType } = require('../middleware/auth');
const { z, id } = require('../validators/common');
const ctrl = require('../controllers/review.controller');
const v = require('../validators/review.validators');

const router = express.Router();

// Public: every approved review across the catalogue (filter by category / rating).
router.get('/', validate({ query: v.publicReviewsQuery }), ctrl.listPublic);

// Public: approved reviews for a product.
router.get(
  '/product/:productId',
  validate({ params: z.object({ productId: id }), query: v.listReviewsQuery }),
  ctrl.listForProduct
);

// Customer: whether the signed-in customer may review this product (+ their own review).
router.get(
  '/product/:productId/eligibility',
  requireAuth,
  requireType('customer'),
  validate({ params: z.object({ productId: id }) }),
  ctrl.eligibility
);

// Customer: submit a review / list own.
router.post(
  '/',
  requireAuth,
  requireType('customer'),
  validate({ body: v.createReviewSchema }),
  ctrl.create
);
router.get(
  '/mine',
  requireAuth,
  requireType('customer'),
  validate({ query: v.listReviewsQuery }),
  ctrl.listMine
);

module.exports = router;
