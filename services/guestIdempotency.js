'use strict';

/**
 * Pure helpers for guest-order idempotency.
 *
 * - The raw Idempotency-Key is never stored or logged: only its SHA-256.
 * - The request fingerprint is a SHA-256 over a canonical form of the fields
 *   that determine the order (never the canonical JSON itself: it holds PII).
 * - For replay after a lost response, the raw guest token is sealed with
 *   AES-256-GCM. The key is HKDF(server secret, salt = raw idempotency key),
 *   and the key hash is bound as associated data, so a database copy alone
 *   (secret or not) cannot recover the token without the client's raw key.
 */

const crypto = require('crypto');
const ApiError = require('../utils/ApiError');

const KEY_PATTERN = /^[A-Za-z0-9_-]{36,128}$/;
const REPLAY_TTL_MS = 24 * 60 * 60 * 1000;
// v2: positions are no longer part of a guest order.
const FINGERPRINT_VERSION = 'guest-order-v2';
const HKDF_INFO = 'caseverse-guest-order-replay-v1';

function parseIdempotencyKey(raw) {
  if (raw === undefined || raw === null || raw === '') {
    throw ApiError.badRequest('A checkout request id is required. Please refresh and try again.', 'idempotency_key_required');
  }
  if (typeof raw !== 'string' || !KEY_PATTERN.test(raw)) {
    throw ApiError.badRequest('The checkout request id is invalid. Please refresh and try again.', 'invalid_idempotency_key');
  }
  return raw;
}

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const hashIdempotencyKey = (key) => sha256(`idempotency:${key}`);

const text = (value) => (value === undefined || value === null ? '' : String(value).trim());

/**
 * Canonical, order-determining view of a validated guest request. Items are
 * folded per variant and sorted, so line order or split lines never change
 * the fingerprint. Client-supplied prices/totals are not part of the
 * validated payload (zod strips them) and are never included.
 */
function canonicalGuestRequest({ items, guest }) {
  const quantities = new Map();
  for (const item of items || []) {
    const variantId = Number(item.variant_id);
    quantities.set(variantId, (quantities.get(variantId) || 0) + Number(item.quantity));
  }
  const lines = [...quantities].sort((a, b) => a[0] - b[0]).map(([variantId, quantity]) => [variantId, quantity]);
  const g = guest || {};
  return [
    FINGERPRINT_VERSION,
    lines,
    [text(g.name), text(g.phone), text(g.province), text(g.district), text(g.municipality), text(g.area), text(g.landmark), text(g.notes)],
    text(g.parcelmoover_destination_id),
  ];
}

const fingerprintGuestRequest = (payload) => sha256(JSON.stringify(canonicalGuestRequest(payload)));

function replayKey(secret, rawKey) {
  if (!secret) throw new Error('Guest replay secret is not configured');
  return Buffer.from(crypto.hkdfSync('sha256', secret, rawKey, HKDF_INFO, 32));
}

function sealGuestToken(token, { rawKey, keyHash, secret }) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', replayKey(secret, rawKey), iv);
  cipher.setAAD(Buffer.from(keyHash));
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
}

/** Returns the raw token, or null when it cannot be recovered (wrong key, rotated secret, tampering). */
function openGuestToken(sealed, { rawKey, keyHash, secret }) {
  try {
    const buffer = Buffer.from(sealed, 'base64url');
    const decipher = crypto.createDecipheriv('aes-256-gcm', replayKey(secret, rawKey), buffer.subarray(0, 12));
    decipher.setAAD(Buffer.from(keyHash));
    decipher.setAuthTag(buffer.subarray(12, 28));
    return Buffer.concat([decipher.update(buffer.subarray(28)), decipher.final()]).toString('utf8');
  } catch (_) {
    return null;
  }
}

module.exports = {
  KEY_PATTERN,
  REPLAY_TTL_MS,
  parseIdempotencyKey,
  hashIdempotencyKey,
  canonicalGuestRequest,
  fingerprintGuestRequest,
  sealGuestToken,
  openGuestToken,
};
