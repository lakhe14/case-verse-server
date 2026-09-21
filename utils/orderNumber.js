'use strict';

const crypto = require('crypto');

/**
 * Human-friendly, collision-resistant order number, e.g. CV-20260907-8F3K2Q.
 * The random suffix is base32 (Crockford-ish) drawn from a CSPRNG.
 */
function generateOrderNumber(date = new Date()) {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  const bytes = crypto.randomBytes(6);
  let suffix = '';
  for (let i = 0; i < 6; i += 1) {
    suffix += alphabet[bytes[i] % alphabet.length];
  }
  return `CV-${y}${m}${d}-${suffix}`;
}

module.exports = { generateOrderNumber };
