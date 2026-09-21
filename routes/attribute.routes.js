'use strict';

const express = require('express');
const ctrl = require('../controllers/attribute.controller');

const router = express.Router();

// Public: list attributes (+ known values). Used by the storefront and admin.
router.get('/', ctrl.list);

module.exports = router;
