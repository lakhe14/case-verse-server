'use strict';

const express = require('express');
const ctrl = require('../controllers/shipping.controller');

const router = express.Router();
router.get('/parcelmoover/destinations', ctrl.destinations);

module.exports = router;
