'use strict';

const asyncHandler = require('../utils/asyncHandler');
const { validateCoupon } = require('../services/coupon.service');

exports.validate = asyncHandler(async (req, res) => {
  const { code, subtotal } = req.body;
  const { coupon, discount_amount } = await validateCoupon({
    code,
    userId: req.auth.id,
    subtotal,
  });
  res.json({
    data: {
      code: coupon.code,
      description: coupon.description,
      discount_type: coupon.discount_type,
      discount_value: Number(coupon.discount_value),
      discount_amount,
      subtotal,
    },
  });
});
