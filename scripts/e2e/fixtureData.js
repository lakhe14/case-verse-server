'use strict';

/**
 * Deterministic data for the isolated E2E database (caseverse_e2e).
 * Pure data: safe to require from the client's Playwright config.
 *
 * PASSWORDS: the defaults below are E2E-ONLY test constants. They exist only
 * in the *_e2e database seeded by scripts/e2e/setup.js, the accounts use a
 * reserved `.test` email domain that does not exist in the dev or production
 * databases, and the E2E server signs tokens with per-run random JWT secrets,
 * so neither these passwords nor E2E tokens authenticate anywhere else.
 * Override any of them with the matching E2E_* environment variable.
 */

const EMAIL_DOMAIN = 'caseverse-e2e.test';
const TAG = 'E2E';

const ACCOUNTS = {
  customerA: {
    type: 'customer',
    name: 'E2E Customer A',
    email: `customer-a@${EMAIL_DOMAIN}`,
    passwordEnv: 'E2E_CUSTOMER_PASSWORD',
    defaultPassword: 'e2e-only-customer-a-pass',
    address: { label: 'E2E fixture', recipient_name: 'E2E Customer A', phone: '9800000001', line1: 'E2E fixture street 1', city: 'Kathmandu', state: 'Bagmati', country: 'Nepal' },
  },
  customerB: {
    type: 'customer',
    name: 'E2E Customer B',
    email: `customer-b@${EMAIL_DOMAIN}`,
    passwordEnv: 'E2E_CUSTOMER_B_PASSWORD',
    defaultPassword: 'e2e-only-customer-b-pass',
    address: { label: 'E2E fixture', recipient_name: 'E2E Customer B', phone: '9800000002', line1: 'E2E fixture street 2', city: 'Lalitpur', state: 'Bagmati', country: 'Nepal' },
  },
  // Extra customers for concurrent-checkout tests (several distinct carts).
  customerC: {
    type: 'customer',
    name: 'E2E Customer C',
    email: `customer-c@${EMAIL_DOMAIN}`,
    passwordEnv: 'E2E_CUSTOMER_C_PASSWORD',
    defaultPassword: 'e2e-only-customer-c-pass',
    address: { label: 'E2E fixture', recipient_name: 'E2E Customer C', phone: '9800000003', line1: 'E2E fixture street 3', city: 'Kathmandu', state: 'Bagmati', country: 'Nepal' },
  },
  customerD: {
    type: 'customer',
    name: 'E2E Customer D',
    email: `customer-d@${EMAIL_DOMAIN}`,
    passwordEnv: 'E2E_CUSTOMER_D_PASSWORD',
    defaultPassword: 'e2e-only-customer-d-pass',
    address: { label: 'E2E fixture', recipient_name: 'E2E Customer D', phone: '9800000004', line1: 'E2E fixture street 4', city: 'Kathmandu', state: 'Bagmati', country: 'Nepal' },
  },
  customerE: {
    type: 'customer',
    name: 'E2E Customer E',
    email: `customer-e@${EMAIL_DOMAIN}`,
    passwordEnv: 'E2E_CUSTOMER_E_PASSWORD',
    defaultPassword: 'e2e-only-customer-e-pass',
    address: { label: 'E2E fixture', recipient_name: 'E2E Customer E', phone: '9800000005', line1: 'E2E fixture street 5', city: 'Kathmandu', state: 'Bagmati', country: 'Nepal' },
  },
  staff: {
    type: 'staff',
    name: 'E2E Payment Staff',
    email: `staff@${EMAIL_DOMAIN}`,
    role: 'Order Manager',
    passwordEnv: 'E2E_STAFF_PASSWORD',
    defaultPassword: 'e2e-only-staff-pass',
  },
  limitedStaff: {
    type: 'staff',
    name: 'E2E Limited Staff',
    email: `limited-staff@${EMAIL_DOMAIN}`,
    role: 'Product Manager',
    passwordEnv: 'E2E_LIMITED_STAFF_PASSWORD',
    defaultPassword: 'e2e-only-limited-staff-pass',
  },
};

function passwordFor(key, source = process.env) {
  const account = ACCOUNTS[key];
  return source[account.passwordEnv] || account.defaultPassword;
}

const PRICE = 699;
const COMPARE_AT_PRICE = 999;

// A small deterministic subset of the real designs (same names, slugs and
// public images) so the storefront renders exactly as in development.
// Stock is fixed per variant and restored exactly by cleanup.
const CATALOG = [
  { name: 'Pink love bow', image: 'Pink_love_bow.png', variants: [['iPhone 12', 10], ['iPhone 12 Pro Max', 10], ['iPhone 13 Pro Max', 10], ['iPhone 14 Pro Max', 10], ['iPhone 16', 5], ['iPhone 17', 5]] },
  { name: 'Flame silver', image: 'Flame_silver.png', variants: [['iPhone 11 Pro', 10]] },
  { name: 'Glossy white', image: 'Glossy_white.png', variants: [['iPhone 14', 10]] },
  { name: 'Pink Floral', image: 'Pink_floral.png', variants: [['iPhone 15 Pro', 10], ['iPhone 17 Pro', 5]] },
  { name: 'Bow cherry iconic', image: 'Bow_cherry_iconic.png', variants: [['iPhone 13', 10], ['iPhone 15', 10]] },
  { name: 'Chetah iconic', image: 'Chetah_iconic.png', variants: [['iPhone 14', 10], ['iPhone 15 Pro', 10]] },
  // Dedicated to stock-arithmetic tests (duplicate lines, restock). Stock 6.
  { name: 'E2E Stock probe', image: 'Glossy_black.png', variants: [['iPhone 15', 6]] },
];

// Deterministic coupons for usage-limit tests. Their uses are removed with the
// fixture orders by cleanup, so every run starts with no active uses.
const COUPONS = [
  { code: 'E2EONCE', description: 'E2E: one use in total', usage_limit_total: 1, usage_limit_per_user: null },
  { code: 'E2EUSERONCE', description: 'E2E: one use per customer', usage_limit_total: null, usage_limit_per_user: 1 },
  { code: 'E2ETHREE', description: 'E2E: three uses in total', usage_limit_total: 3, usage_limit_per_user: null },
  { code: 'E2EPAIDONCE', description: 'E2E: one use in total (paid cancellation)', usage_limit_total: 1, usage_limit_per_user: null },
  { code: 'E2EBROWSERONCE', description: 'E2E: one use in total (browser flow)', usage_limit_total: 1, usage_limit_per_user: null },
];
const COUPON_DISCOUNT = 50;

module.exports = { TAG, EMAIL_DOMAIN, ACCOUNTS, passwordFor, PRICE, COMPARE_AT_PRICE, CATALOG, COUPONS, COUPON_DISCOUNT };
