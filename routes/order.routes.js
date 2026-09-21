'use strict';

const express = require('express');
const validate = require('../middleware/validate');
const { requireAuth, requireType } = require('../middleware/auth');
const { idParam } = require('../validators/common');
const ctrl = require('../controllers/order.controller');
const v = require('../validators/order.validators');

const router = express.Router();
router.use(requireAuth, requireType('customer'));

router.post('/preview', validate({ body: v.previewSchema }), ctrl.preview);
router.post('/', validate({ body: v.placeOrderSchema }), ctrl.place);
router.get('/', validate({ query: v.listOrdersQuery }), ctrl.listMine);
router.get('/:id', validate({ params: idParam }), ctrl.getMine);

module.exports = router;
