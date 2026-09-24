'use strict';

const rateLimit = require('express-rate-limit');

/**
 * Small, consistent limits for abusive public and sensitive actions.  Keep the
 * response deliberately generic: retry headers are sufficient for clients and
 * do not disclose limiter state or account information.
 */
function limit({ windowMs = 15 * 60 * 1000, max }) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: { message: 'Too many requests. Please try again later.', code: 'rate_limited' } },
  });
}

module.exports = {
  couponValidation: limit({ max: 30 }),
  customerCod: limit({ max: 12 }),
  customerProof: limit({ max: 8 }),
  guestCod: limit({ max: 12 }),
  // Guest tokens are 32 random bytes (not guessable); this only curbs scraping,
  // and must allow many guests behind one shared mobile IP.
  guestLookup: limit({ max: 300 }),
  shippingDestinations: limit({ windowMs: 5 * 60 * 1000, max: 120 }),
  // One tap per lookup; the upstream geocoder allows about 1 request/second overall.
  geoReverse: limit({ max: 20 }),
  // Debounced search-as-you-type against the offline index.
  // Generous: many shoppers can share one mobile (CGNAT) IP.
  localitySearch: limit({ windowMs: 5 * 60 * 1000, max: 600 }),
  staffPaymentActions: limit({ max: 60 }),
};
