'use strict';

const { generateOpaqueToken, hashOpaqueToken } = require('../utils/tokens');
const { nepaliPhone } = require('../validators/common');
const { normalizeGuestItems } = require('../services/order.service');

describe('guest order access token', () => {
  it('is high entropy and hashes deterministically', () => {
    const { raw, hash } = generateOpaqueToken();
    expect(raw.length).toBeGreaterThanOrEqual(32);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashOpaqueToken(raw)).toBe(hash);
  });

  it('never repeats across many calls', () => {
    const seen = new Set();
    for (let i = 0; i < 2000; i += 1) seen.add(generateOpaqueToken().raw);
    expect(seen.size).toBe(2000);
  });

  it('a different raw token hashes to a different value', () => {
    const a = generateOpaqueToken();
    const b = generateOpaqueToken();
    expect(hashOpaqueToken(a.raw)).not.toBe(hashOpaqueToken(b.raw));
  });
});

describe('Nepal-friendly phone validation', () => {
  const valid = ['9812345678', '+977 9812345678', '+9779812345678', '09812345678', '9765432198'];
  const invalid = ['12345', '8812345678', '981234567', '98123456789', 'abcdefghij'];

  it.each(valid)('accepts %s', (phone) => {
    expect(() => nepaliPhone.parse(phone)).not.toThrow();
  });

  it.each(invalid)('rejects %s', (phone) => {
    expect(() => nepaliPhone.parse(phone)).toThrow();
  });
});

describe('Guest checkout input normalization', () => {
  it('merges duplicate variants before stock is checked', () => {
    expect(normalizeGuestItems([
      { variant_id: 42, quantity: 4 }, { variant_id: 42, quantity: 4 }, { variant_id: 8, quantity: 1 },
    ])).toEqual([{ variant_id: 42, quantity: 8 }, { variant_id: 8, quantity: 1 }]);
  });
});
