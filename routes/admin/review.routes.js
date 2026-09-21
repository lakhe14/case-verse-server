'use strict';

const express = require('express');
const validate = require('../../middleware/validate');
const { requirePermission } = require('../../middleware/auth');
const { idParam } = require('../../validators/common');
const ctrl = require('../../controllers/admin/review.controller');
const v = require('../../validators/review.validators');

const router = express.Router();
const canManage = requirePermission('manage_reviews');

router.get('/reviews', canManage, validate({ query: v.adminListReviewsQuery }), ctrl.list);
router.put('/reviews/:id', canManage, validate({ params: idParam, body: v.moderateReviewSchema }), ctrl.moderate);

module.exports = router;
