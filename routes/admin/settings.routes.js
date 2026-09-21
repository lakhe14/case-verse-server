'use strict';

const express = require('express');
const validate = require('../../middleware/validate');
const { requirePermission } = require('../../middleware/auth');
const ctrl = require('../../controllers/admin/settings.controller');
const v = require('../../validators/admin.validators');

const router = express.Router();
const canManage = requirePermission('manage_settings');

router.get('/settings/shipping', canManage, ctrl.getShipping);
router.put('/settings/shipping', canManage, validate({ body: v.shippingRatesSchema }), ctrl.putShipping);

router.get('/settings/general', canManage, ctrl.getGeneral);
router.put('/settings/general', canManage, validate({ body: v.generalSettingsSchema }), ctrl.putGeneral);

module.exports = router;
