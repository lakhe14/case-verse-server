'use strict';

const express = require('express');
const validate = require('../../middleware/validate');
const { requirePermission } = require('../../middleware/auth');
const { idParam } = require('../../validators/common');
const ctrl = require('../../controllers/admin/staff.controller');
const v = require('../../validators/admin.validators');

const router = express.Router();
const canManage = requirePermission('manage_staff');

router.get('/staff', canManage, ctrl.listStaff);
router.post('/staff', canManage, validate({ body: v.createStaffSchema }), ctrl.createStaff);
router.put('/staff/:id', canManage, validate({ params: idParam, body: v.updateStaffSchema }), ctrl.updateStaff);
router.delete('/staff/:id', canManage, validate({ params: idParam }), ctrl.deleteStaff);

router.get('/roles', canManage, ctrl.listRoles);
router.post('/roles', canManage, validate({ body: v.createRoleSchema }), ctrl.createRole);
router.put('/roles/:id/permissions', canManage, validate({ params: idParam, body: v.setRolePermissionsSchema }), ctrl.setRolePermissions);

router.get('/permissions', canManage, ctrl.listPermissions);

module.exports = router;
