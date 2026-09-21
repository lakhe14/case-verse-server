'use strict';

const express = require('express');
const validate = require('../../middleware/validate');
const { requirePermission } = require('../../middleware/auth');
const { idParam } = require('../../validators/common');
const ctrl = require('../../controllers/admin/order.controller');
const v = require('../../validators/order.validators');

const router = express.Router();
const canManage = requirePermission('manage_orders');

router.get('/orders', canManage, validate({ query: v.listOrdersQuery }), ctrl.list);
router.get('/orders/:id', canManage, validate({ params: idParam }), ctrl.get);
router.put('/orders/:id/status', canManage, validate({ params: idParam, body: v.updateStatusSchema }), ctrl.updateStatus);

module.exports = router;
