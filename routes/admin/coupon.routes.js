'use strict';

const express = require('express');
const validate = require('../../middleware/validate');
const { requirePermission } = require('../../middleware/auth');
const { idParam, paginationQuery } = require('../../validators/common');
const ctrl = require('../../controllers/admin/coupon.controller');
const v = require('../../validators/admin.validators');

const router = express.Router();
const canManage = requirePermission('manage_coupons');

router.get('/coupons', canManage, validate({ query: paginationQuery }), ctrl.list);
router.post('/coupons', canManage, validate({ body: v.createCouponSchema }), ctrl.create);
router.put('/coupons/:id', canManage, validate({ params: idParam, body: v.updateCouponSchema }), ctrl.update);
router.delete('/coupons/:id', canManage, validate({ params: idParam }), ctrl.remove);

module.exports = router;
