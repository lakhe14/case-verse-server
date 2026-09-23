'use strict';

const express = require('express');
const ctrl = require('../controllers/shipping.controller');
const { shippingDestinations } = require('../middleware/rateLimiters');

const router = express.Router();
router.get('/parcelmoover/destinations', shippingDestinations, ctrl.destinations);

module.exports = router;
