'use strict';

const express = require('express');
const validate = require('../middleware/validate');
const { idParam } = require('../validators/common');
const ctrl = require('../controllers/category.controller');

const router = express.Router();

router.get('/', ctrl.list);
router.get('/:id/attributes', validate({ params: idParam }), ctrl.attributes);

module.exports = router;
