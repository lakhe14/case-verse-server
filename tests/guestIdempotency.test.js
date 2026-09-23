'use strict';

const crypto = require('crypto');
const {
  parseIdempotencyKey, hashIdempotencyKey, fingerprintGuestRequest, canonicalGuestRequest, sealGuestToken, openGuestToken,
} = require('../services/guestIdempotency');

const guest = {
  name: 'E2E Guest', phone: '9800000000', province: 'Bagmati', district: 'Kathmandu', municipality: 'Kathmandu',
  area: 'Lane 1', landmark: 'Temple', notes: 'Ring bell', parcelmoover_destination_id: 'dest-1',
};
const items = [{ variant_id: 7, quantity: 1 }, { variant_id: 3, quantity: 2 }];

describe('Idempotency-Key validation', () => {
  it('accepts UUIDs and 36-128 char URL-safe keys', () => {
    const uuid = crypto.randomUUID();
    expect(parseIdempotencyKey(uuid)).toBe(uuid);
    expect(parseIdempotencyKey('a'.repeat(128))).toHaveLength(128);
  });

  it.each([
    [undefined, 'idempotency_key_required'],
    ['', 'idempotency_key_required'],
    ['short-key', 'invalid_idempotency_key'],
    ['a'.repeat(129), 'invalid_idempotency_key'],
    [`${'a'.repeat(40)} OR 1=1`, 'invalid_idempotency_key'],
    [`${'a'.repeat(40)}\n`, 'invalid_idempotency_key'],
    [['array'], 'invalid_idempotency_key'],
  ])('rejects %p with 400 %s', (value, code) => {
    expect(() => parseIdempotencyKey(value)).toThrow(expect.objectContaining({ status: 400, code }));
  });

  it('hashes keys to 64 hex chars without echoing the key', () => {
    const key = crypto.randomUUID();
    const hash = hashIdempotencyKey(key);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).not.toContain(key);
    expect(hashIdempotencyKey(key)).toBe(hash);
  });
});

describe('request fingerprint', () => {
  it('is stable for the same payload', () => {
    expect(fingerprintGuestRequest({ items, guest })).toBe(fingerprintGuestRequest({ items: [...items], guest: { ...guest } }));
  });

  it('ignores cart line order and split duplicate lines', () => {
    const reordered = [{ variant_id: 3, quantity: 2 }, { variant_id: 7, quantity: 1 }];
    const split = [{ variant_id: 3, quantity: 1 }, { variant_id: 7, quantity: 1 }, { variant_id: 3, quantity: 1 }];
    const base = fingerprintGuestRequest({ items, guest });
    expect(fingerprintGuestRequest({ items: reordered, guest })).toBe(base);
    expect(fingerprintGuestRequest({ items: split, guest })).toBe(base);
  });

  it('ignores surrounding whitespace and client price fields', () => {
    const noisy = items.map((item) => ({ ...item, unit_price: 1, line_total: 1 }));
    expect(fingerprintGuestRequest({ items: noisy, guest: { ...guest, name: '  E2E Guest ', total_amount: 1 } }))
      .toBe(fingerprintGuestRequest({ items, guest }));
  });

  it.each([
    ['quantity', { items: [{ variant_id: 7, quantity: 2 }, { variant_id: 3, quantity: 2 }], guest }],
    ['variant', { items: [{ variant_id: 8, quantity: 1 }, { variant_id: 3, quantity: 2 }], guest }],
    ['destination', { items, guest: { ...guest, parcelmoover_destination_id: 'dest-2' } }],
    ['phone', { items, guest: { ...guest, phone: '9811111111' } }],
    ['address', { items, guest: { ...guest, area: 'Lane 2' } }],
  ])('changes when the %s changes', (_label, payload) => {
    expect(fingerprintGuestRequest(payload)).not.toBe(fingerprintGuestRequest({ items, guest }));
  });

  it('stores only a hash, never the canonical PII', () => {
    const fingerprint = fingerprintGuestRequest({ items, guest });
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprint).not.toContain('9800000000');
    expect(canonicalGuestRequest({ items, guest })[1]).toEqual([[3, 2], [7, 1]]);
  });
});

describe('sealed replay token', () => {
  const secret = crypto.randomBytes(32).toString('hex');
  const rawKey = crypto.randomUUID();
  const keyHash = hashIdempotencyKey(rawKey);

  it('round-trips only with the same raw key, key hash and secret', () => {
    const sealed = sealGuestToken('raw-guest-token', { rawKey, keyHash, secret });
    expect(sealed).not.toContain('raw-guest-token');
    expect(openGuestToken(sealed, { rawKey, keyHash, secret })).toBe('raw-guest-token');
    expect(openGuestToken(sealed, { rawKey: crypto.randomUUID(), keyHash, secret })).toBeNull();
    expect(openGuestToken(sealed, { rawKey, keyHash: hashIdempotencyKey('other'), secret })).toBeNull();
    expect(openGuestToken(sealed, { rawKey, keyHash, secret: 'rotated' })).toBeNull();
    expect(openGuestToken('tampered', { rawKey, keyHash, secret })).toBeNull();
  });
});
