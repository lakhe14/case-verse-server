'use strict';

const express = require('express');
const validate = require('../middleware/validate');
const ctrl = require('../controllers/geo.controller');
const v = require('../validators/geo.validators');
const limits = require('../middleware/rateLimiters');

// Public (guest checkout uses both). POST keeps positions and search text out
// of URLs, and so out of access logs.
const router = express.Router();
router.post('/reverse', limits.geoReverse, validate({ body: v.reverseSchema }), ctrl.reverse);
router.post('/localities/search', limits.localitySearch, validate({ body: v.localitySearchSchema }), ctrl.searchLocalities);

module.exports = router;
