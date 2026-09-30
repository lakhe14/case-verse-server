'use strict';

const { z } = require('./common');

// CV-YYYYMMDD-XXXXXX (utils/orderNumber.js); accepted in any case and with stray spaces.
const orderNumber = z
  .string()
  .transform((value) => value.replace(/\s+/g, '').toUpperCase())
  .pipe(z.string().regex(/^CV-\d{8}-[0-9A-HJKMNP-TV-Z]{6}$/, 'Enter the order ID exactly as shown, e.g. CV-20260927-8F3K2Q'));

// Loose on purpose: +977, spaces and dashes are normalized by the service.
const phone = z.string().trim().min(9, 'Enter the phone number used for the order').max(25);

const trackOrderSchema = z.object({ order_number: orderNumber, phone });

module.exports = { trackOrderSchema };
