'use strict';

const express = require('express');
const validate = require('../middleware/validate');
const ctrl = require('../controllers/product.controller');
const v = require('../validators/product.validators');

const router = express.Router();

router.get('/', validate({ query: v.listProductsQuery }), ctrl.list);
router.get('/bestsellers', ctrl.bestsellers); // must precede /:slug
router.get('/:slug', validate({ params: v.slugParam }), ctrl.getBySlug);

module.exports = router;
