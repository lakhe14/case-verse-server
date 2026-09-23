'use strict';

/**
 * Seeding, scoped cleanup and verification for the isolated E2E database.
 * Callers MUST run loadE2eEnv() first: requiring this module loads the models,
 * which connect to whatever config/env.js resolves (guarded to *_e2e).
 */

const fs = require('fs');
const path = require('path');
const { Op } = require('sequelize');
const db = require('../../models');
const env = require('../../config/env');
const { assertE2eDatabaseName, assertE2eDirectory } = require('../../config/e2eGuard');
const { hashPassword } = require('../../services/password.service');
const { slugify } = require('../../utils/slug');
const { seedRbac } = require('../seed');
const { TAG, ACCOUNTS, passwordFor, PRICE, COMPARE_AT_PRICE, CATALOG } = require('./fixtureData');

const CATEGORY_SLUG = 'iphone-covers';
const PHONE_MODEL = 'Phone Model';

const skuFor = (productName, model) => `CV-${slugify(productName)}-${slugify(model)}`.slice(0, 64).toUpperCase();

function fixtureStock() {
  return new Map(CATALOG.flatMap((item) => item.variants.map(([model, stock]) => [skuFor(item.name, model), stock])));
}

/** Refuses to touch anything unless the live connection really is an *_e2e database. */
async function assertConnectedToE2e() {
  const [[row]] = await db.sequelize.query('SELECT DATABASE() AS name');
  assertE2eDatabaseName(row.name);
  assertE2eDatabaseName(env.db.name);
  return row.name;
}

/**
 * Orders that belong to E2E fixtures: anything owned by a fixture customer, or
 * a guest order carrying the E2E tag in its name or delivery notes. With a run
 * id, guest orders are narrowed to that run. Never returns an unscoped filter.
 */
function buildOrderScope({ userIds = [], runId } = {}) {
  const guestTag = runId
    ? { guest_delivery_notes: { [Op.like]: `%${runId}%` } }
    : { [Op.or]: [{ guest_name: { [Op.like]: `${TAG}%` } }, { guest_delivery_notes: { [Op.like]: `%${TAG}-%` } }] };
  const clauses = [{ user_id: null, ...guestTag }];
  if (userIds.length) clauses.push({ user_id: { [Op.in]: userIds } });
  return { [Op.or]: clauses };
}

async function fixtureUsers() {
  const emails = Object.values(ACCOUNTS).filter((a) => a.type === 'customer').map((a) => a.email);
  return db.User.findAll({ where: { email: { [Op.in]: emails } } });
}

async function seedAccounts() {
  const roles = new Map((await db.Role.findAll()).map((role) => [role.name, role]));
  const summary = [];
  for (const [key, account] of Object.entries(ACCOUNTS)) {
    const password_hash = await hashPassword(passwordFor(key));
    if (account.type === 'staff') {
      const role = roles.get(account.role);
      if (!role) throw new Error(`Role "${account.role}" missing after RBAC seed`);
      const [staff] = await db.Staff.findOrCreate({ where: { email: account.email }, defaults: { name: account.name, email: account.email, password_hash, role_id: role.id } });
      await staff.update({ name: account.name, password_hash, role_id: role.id, is_active: true });
      summary.push(`${key}: staff (${account.role})`);
    } else {
      const [user] = await db.User.findOrCreate({ where: { email: account.email }, defaults: { name: account.name, email: account.email, password_hash } });
      await user.update({ name: account.name, password_hash, is_active: true, loyalty_points: 0 });
      const existing = await db.Address.findOne({ where: { user_id: user.id, label: account.address.label } });
      if (existing) await existing.update({ ...account.address, is_default: true });
      else await db.Address.create({ ...account.address, user_id: user.id, is_default: true });
      summary.push(`${key}: customer`);
    }
  }
  return summary;
}

async function seedCatalog() {
  const [category] = await db.Category.findOrCreate({ where: { slug: CATEGORY_SLUG }, defaults: { name: 'iPhone Covers', slug: CATEGORY_SLUG } });
  const [attribute] = await db.Attribute.findOrCreate({ where: { name: PHONE_MODEL }, defaults: { name: PHONE_MODEL } });
  await db.CategoryAttribute.findOrCreate({ where: { category_id: category.id, attribute_id: attribute.id } });
  let variants = 0;
  for (const item of CATALOG) {
    const slug = slugify(item.name);
    const [product] = await db.Product.findOrCreate({
      where: { slug },
      defaults: { category_id: category.id, name: item.name, slug, description: null, base_price: PRICE, status: 'active' },
    });
    await product.update({ category_id: category.id, name: item.name, base_price: PRICE, status: 'active' });
    const url = `/assets/caseverse/${item.image}`;
    await db.ProductImage.findOrCreate({ where: { product_id: product.id, variant_id: null, url }, defaults: { product_id: product.id, variant_id: null, url, sort_order: 0 } });
    for (const [model, stock] of item.variants) {
      const sku = skuFor(item.name, model);
      const [variant] = await db.ProductVariant.findOrCreate({
        where: { sku },
        defaults: { product_id: product.id, sku, price: PRICE, compare_at_price: COMPARE_AT_PRICE, stock_quantity: stock, is_active: true },
      });
      await variant.update({ product_id: product.id, price: PRICE, compare_at_price: COMPARE_AT_PRICE, stock_quantity: stock, is_active: true });
      await db.VariantAttributeValue.findOrCreate({ where: { variant_id: variant.id, attribute_id: attribute.id }, defaults: { variant_id: variant.id, attribute_id: attribute.id, value: model } });
      variants += 1;
    }
  }
  return { products: CATALOG.length, variants };
}

/** Removes only files inside the verified E2E proof directory. */
function sweepProofFiles() {
  const dir = assertE2eDirectory(env.uploads.proofDir, 'PRIVATE_UPLOAD_DIR');
  if (!fs.existsSync(dir)) return 0;
  let removed = 0;
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    if (fs.statSync(file).isFile()) {
      fs.unlinkSync(file);
      removed += 1;
    }
  }
  return removed;
}

async function cleanup({ runId } = {}) {
  await assertConnectedToE2e();
  const users = await fixtureUsers();
  const userIds = users.map((u) => u.id);
  const counts = {};
  await db.sequelize.transaction(async (transaction) => {
    const orders = await db.Order.findAll({ where: buildOrderScope({ userIds, runId }), attributes: ['id'], transaction });
    const orderIds = orders.map((o) => o.id);
    counts.orders = orderIds.length;
    if (orderIds.length) {
      const items = await db.OrderItem.findAll({ where: { order_id: { [Op.in]: orderIds } }, attributes: ['id'], transaction });
      if (items.length) await db.Review.update({ order_item_id: null }, { where: { order_item_id: { [Op.in]: items.map((i) => i.id) } }, transaction });
      counts.payment_confirmations = await db.OrderPaymentConfirmation.destroy({ where: { order_id: { [Op.in]: orderIds } }, transaction });
      await db.CouponUsage.destroy({ where: { order_id: { [Op.in]: orderIds } }, transaction });
      await db.LoyaltyTransaction.destroy({ where: { order_id: { [Op.in]: orderIds } }, transaction });
      // guest tokens, items, promo items and status history cascade with the order.
      await db.Order.destroy({ where: { id: { [Op.in]: orderIds } }, transaction });
    } else {
      counts.payment_confirmations = 0;
    }
    if (userIds.length) {
      const carts = await db.Cart.findAll({ where: { user_id: { [Op.in]: userIds } }, attributes: ['id'], transaction });
      counts.cart_items = carts.length ? await db.CartItem.destroy({ where: { cart_id: { [Op.in]: carts.map((c) => c.id) } }, transaction }) : 0;
      counts.wishlist = await db.Wishlist.destroy({ where: { user_id: { [Op.in]: userIds } }, transaction });
      counts.reviews = await db.Review.destroy({ where: { user_id: { [Op.in]: userIds } }, transaction });
      await db.LoyaltyTransaction.destroy({ where: { user_id: { [Op.in]: userIds } }, transaction });
      await db.User.update({ loyalty_points: 0 }, { where: { id: { [Op.in]: userIds } }, transaction });
      counts.extra_addresses = await db.Address.destroy({ where: { user_id: { [Op.in]: userIds }, label: { [Op.ne]: 'E2E fixture' } }, transaction });
    }
    let restocked = 0;
    for (const [sku, stock] of fixtureStock()) {
      const [changed] = await db.ProductVariant.update({ stock_quantity: stock, is_active: true }, { where: { sku, stock_quantity: { [Op.ne]: stock } }, transaction });
      restocked += changed;
    }
    counts.variants_restocked = restocked;
  });
  counts.proof_files = sweepProofFiles();
  return counts;
}

async function verify() {
  await assertConnectedToE2e();
  const users = await fixtureUsers();
  const userIds = users.map((u) => u.id);
  const scope = buildOrderScope({ userIds });
  const orderIds = (await db.Order.findAll({ where: scope, attributes: ['id'] })).map((o) => o.id);
  const stock = fixtureStock();
  const variants = await db.ProductVariant.findAll({ where: { sku: { [Op.in]: [...stock.keys()] } } });
  const carts = await db.Cart.findAll({ where: { user_id: { [Op.in]: userIds } }, attributes: ['id'] });
  const staffEmails = Object.values(ACCOUNTS).filter((a) => a.type === 'staff').map((a) => a.email);
  const dir = env.uploads.proofDir;
  return {
    e2e_orders: orderIds.length,
    e2e_payment_confirmations: orderIds.length ? await db.OrderPaymentConfirmation.count({ where: { order_id: { [Op.in]: orderIds } } }) : 0,
    e2e_guest_orders: await db.Order.count({ where: buildOrderScope({}) }),
    other_orders_in_e2e_db: (await db.Order.count()) - orderIds.length,
    proof_files: fs.existsSync(dir) ? fs.readdirSync(dir).length : 0,
    stock_mismatches: variants.filter((v) => v.stock_quantity !== stock.get(v.sku)).length + (stock.size - variants.length),
    fixture_cart_items: carts.length ? await db.CartItem.count({ where: { cart_id: { [Op.in]: carts.map((c) => c.id) } } }) : 0,
    fixture_customers_active: users.filter((u) => u.is_active).length,
    fixture_staff_active: await db.Staff.count({ where: { email: { [Op.in]: staffEmails }, is_active: true } }),
  };
}

function isClean(result) {
  return result.e2e_orders === 0 && result.e2e_payment_confirmations === 0 && result.e2e_guest_orders === 0
    && result.other_orders_in_e2e_db === 0 && result.proof_files === 0 && result.stock_mismatches === 0
    && result.fixture_cart_items === 0 && result.fixture_customers_active === 2 && result.fixture_staff_active === 2;
}

async function seedAll() {
  const databaseName = await assertConnectedToE2e();
  await seedRbac();
  const accounts = await seedAccounts();
  const catalog = await seedCatalog();
  return { databaseName, accounts, catalog };
}

module.exports = { skuFor, fixtureStock, buildOrderScope, assertConnectedToE2e, seedAll, cleanup, verify, isClean, sweepProofFiles };
