'use strict';

const express = require('express');
const validate = require('../middleware/validate');
const { requireAuth, requireType } = require('../middleware/auth');
const { idParam } = require('../validators/common');
const ctrl = require('../controllers/address.controller');
const v = require('../validators/address.validators');

const router = express.Router();

router.use(requireAuth, requireType('customer'));

router.get('/', ctrl.list);
router.post('/', validate({ body: v.createAddressSchema }), ctrl.create);
router.get('/:id', validate({ params: idParam }), ctrl.get);
router.put('/:id', validate({ params: idParam, body: v.updateAddressSchema }), ctrl.update);
router.delete('/:id', validate({ params: idParam }), ctrl.remove);
router.post('/:id/default', validate({ params: idParam }), ctrl.setDefault);

module.exports = router;
