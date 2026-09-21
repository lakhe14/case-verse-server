'use strict';

const express = require('express');
const validate = require('../middleware/validate');
const { requireAuth, requireType } = require('../middleware/auth');
const { paginationQuery } = require('../validators/common');
const ctrl = require('../controllers/loyalty.controller');

const router = express.Router();
router.use(requireAuth, requireType('customer'));

router.get('/balance', ctrl.balance);
router.get('/transactions', validate({ query: paginationQuery }), ctrl.transactions);

module.exports = router;
