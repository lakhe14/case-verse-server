'use strict';

const express = require('express');
const validate = require('../middleware/validate');
const { requireAuth, requireType } = require('../middleware/auth');
const { idParam } = require('../validators/common');
const ctrl = require('../controllers/cart.controller');
const v = require('../validators/cart.validators');

const router = express.Router();
router.use(requireAuth, requireType('customer'));

router.get('/', ctrl.get);
router.post('/items', validate({ body: v.addItemSchema }), ctrl.addItem);
router.put('/items/:id', validate({ params: idParam, body: v.updateItemSchema }), ctrl.updateItem);
router.delete('/items/:id', validate({ params: idParam }), ctrl.removeItem);
router.delete('/', ctrl.clear);

module.exports = router;
