'use strict';

const express = require('express');
const validate = require('../../middleware/validate');
const { requirePermission } = require('../../middleware/auth');
const { idParam, paginationQuery, z } = require('../../validators/common');
const ctrl = require('../../controllers/admin/analytics.controller');
const v = require('../../validators/admin.validators');

const router = express.Router();
const canView = requirePermission('view_analytics');
const canManageCustomers = requirePermission('manage_customers');

router.get('/analytics/overview', canView, ctrl.overview);
router.get('/analytics/dashboard', canView, validate({ query: v.dashboardQuery }), ctrl.dashboard);
router.get('/analytics/sales', canView, validate({ query: v.salesQuery }), ctrl.sales);
router.get('/analytics/top-products', canView, validate({ query: v.topProductsQuery }), ctrl.topProducts);

const customerListQuery = paginationQuery.extend({ q: z.string().trim().max(120).optional() });
router.get('/customers', canManageCustomers, validate({ query: customerListQuery }), ctrl.listCustomers);
router.get('/customers/:id', canManageCustomers, validate({ params: idParam }), ctrl.customerDetail);

module.exports = router;
