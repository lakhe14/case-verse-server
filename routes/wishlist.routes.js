'use strict';

const express = require('express');
const validate = require('../middleware/validate');
const { requireAuth, requireType } = require('../middleware/auth');
const ctrl = require('../controllers/wishlist.controller');
const v = require('../validators/wishlist.validators');

const router = express.Router();
router.use(requireAuth, requireType('customer'));

router.get('/', ctrl.list);
router.post('/', validate({ body: v.addWishlistSchema }), ctrl.add);
router.delete('/:productId', validate({ params: v.productIdParam }), ctrl.remove);

module.exports = router;
