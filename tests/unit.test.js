'use strict';

const { generateOrderNumber } = require('../utils/orderNumber');
const { slugify } = require('../utils/slug');

describe('orderNumber', () => {
  it('has the CV-YYYYMMDD-XXXXXX shape', () => {
    const n = generateOrderNumber(new Date(Date.UTC(2026, 8, 7)));
    expect(n).toMatch(/^CV-20260907-[0-9A-HJ-NP-TV-Z]{6}$/);
  });

  it('is unique across many calls', () => {
    const seen = new Set();
    for (let i = 0; i < 5000; i += 1) seen.add(generateOrderNumber());
    expect(seen.size).toBe(5000);
  });
});

describe('slugify', () => {
  it('lowercases and dashes', () => {
    expect(slugify('Silicone MagSafe Case')).toBe('silicone-magsafe-case');
  });
  it('strips punctuation and collapses separators', () => {
    expect(slugify('Clear  Bumper!! (New)')).toBe('clear-bumper-new');
  });
});
