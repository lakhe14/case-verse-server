'use strict';

/**
 * Shared helpers for DB-backed integration tests. Only ever loaded by
 * scripts/e2e/runIntegration.js, which has already verified NODE_ENV=e2e and
 * an *_e2e database; config/env.js re-checks on require.
 */

const crypto = require('crypto');
const fs = require('fs');
const request = require('supertest');
const app = require('../../app');
const db = require('../../models');
const env = require('../../config/env');
const { assertE2eDatabaseName } = require('../../config/e2eGuard');
const { ACCOUNTS, passwordFor } = require('../../scripts/e2e/fixtureData');
const { skuFor } = require('../../scripts/e2e/fixtures');

assertE2eDatabaseName(env.db.name);
db.sequelize.options.logging = false;

const RUN_ID = process.env.E2E_RUN_ID;
const api = () => request(app);
const sessions = new Map();

async function login(kind) {
  if (sessions.has(kind)) return sessions.get(kind);
  const account = ACCOUNTS[kind];
  const path = account.type === 'staff' ? '/api/staff/login' : '/api/auth/login';
  const res = await api().post(path).send({ email: account.email, password: passwordFor(kind) });
  if (res.status !== 200) throw new Error(`${kind} fixture login failed with ${res.status}`);
  const session = { token: res.body.accessToken, profile: res.body.user || res.body.staff };
  sessions.set(kind, session);
  return session;
}

const auth = (session) => ({ Authorization: `Bearer ${session.token}` });

const SKU = {
  pinkBow12: skuFor('Pink love bow', 'iPhone 12'),
  pinkBow12ProMax: skuFor('Pink love bow', 'iPhone 12 Pro Max'),
  pinkBow13ProMax: skuFor('Pink love bow', 'iPhone 13 Pro Max'),
  pinkBow14ProMax: skuFor('Pink love bow', 'iPhone 14 Pro Max'),
  glossyWhite: skuFor('Glossy white', 'iPhone 14'),
  chetah14: skuFor('Chetah iconic', 'iPhone 14'),
  chetah15Pro: skuFor('Chetah iconic', 'iPhone 15 Pro'),
  bowCherry13: skuFor('Bow cherry iconic', 'iPhone 13'),
  bowCherry15: skuFor('Bow cherry iconic', 'iPhone 15'),
  pinkFloral17Pro: skuFor('Pink Floral', 'iPhone 17 Pro'),
  flameSilver: skuFor('Flame silver', 'iPhone 11 Pro'),
  pinkBow17: skuFor('Pink love bow', 'iPhone 17'),
  pinkFloral15Pro: skuFor('Pink Floral', 'iPhone 15 Pro'),
  stockProbe: skuFor('E2E Stock probe', 'iPhone 15'),
};

async function variant(sku) {
  return db.ProductVariant.findOne({ where: { sku } });
}

/** Physical stock (product_variants.stock_quantity). */
async function stockOf(sku) {
  return (await variant(sku)).stock_quantity;
}

/** { physical, reserved, available } using the same service the API uses. */
async function inventoryOf(sku) {
  const v = await variant(sku);
  return (await require('../../services/inventory.service').availabilityFor([v])).get(v.id);
}

async function defaultAddressId(session) {
  const res = await api().get('/api/addresses').set(auth(session));
  return res.body.data.find((a) => a.is_default).id;
}

async function clearCart(session) {
  await api().delete('/api/cart').set(auth(session));
}

/** Places a real customer order for the given lines through the cart. */
async function placeCustomerOrder(kind, lines, { destination = 'e2e-kathmandu', extra = {} } = {}) {
  const session = await login(kind);
  await clearCart(session);
  for (const { sku, quantity } of lines) {
    const res = await api().post('/api/cart/items').set(auth(session)).send({ variant_id: (await variant(sku)).id, quantity });
    if (res.status !== 201) throw new Error(`cart add failed: ${res.status} ${res.body?.error?.code}`);
  }
  const addressId = await defaultAddressId(session);
  return api().post('/api/orders').set(auth(session)).send({ shipping_address_id: addressId, parcelmoover_destination_id: destination, ...extra });
}

function guestDetails(label = 'guest') {
  return {
    name: `E2E ${label}`,
    phone: '9800000009',
    province: 'Bagmati',
    district: 'Kathmandu',
    municipality: 'Kathmandu',
    area: 'E2E fixture lane',
    notes: `${RUN_ID} ${label}`,
    parcelmoover_destination_id: 'e2e-kathmandu',
  };
}

/** Places a real guest order. The raw token stays in memory and is never printed. */
const newIdempotencyKey = () => crypto.randomUUID();

async function placeGuestOrder(lines, { label = 'guest', extra = {}, guestExtra = {}, key = newIdempotencyKey() } = {}) {
  const items = [];
  for (const { sku, quantity } of lines) items.push({ variant_id: (await variant(sku)).id, quantity });
  return api().post('/api/guest-checkout/orders').set('Idempotency-Key', key).send({ items, guest: { ...guestDetails(label), ...guestExtra }, ...extra });
}

function proofFiles() {
  return fs.existsSync(env.uploads.proofDir) ? fs.readdirSync(env.uploads.proofDir) : [];
}

// Smallest valid PNG, generated per test run from constant bytes (no real proof images).
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

module.exports = { api, db, env, RUN_ID, login, auth, SKU, variant, stockOf, inventoryOf, clearCart, placeCustomerOrder, placeGuestOrder, newIdempotencyKey, guestDetails, proofFiles, PNG };
