'use strict';

const crypto = require('crypto');
const { Op } = require('sequelize');
const db = require('../models');
const ApiError = require('../utils/ApiError');
const inventory = require('./inventory.service');
const cache = require('./cache.service');

const productInclude = [
  { model: db.Category, as: 'category' },
  {
    model: db.ProductVariant,
    as: 'variants',
    include: [
      {
        model: db.VariantAttributeValue,
        as: 'attributeValues',
        include: [{ model: db.Attribute, as: 'attribute' }],
      },
      { model: db.ProductImage, as: 'images' },
    ],
  },
  { model: db.ProductImage, as: 'images' },
];

/**
 * Stock semantics:
 * - public (storefront) shape: stock_quantity is AVAILABLE to sell
 *   (physical minus active reservations); reservation details are not exposed.
 * - admin shape: stock_quantity is PHYSICAL (what the product form edits),
 *   plus explicit reserved_quantity and available_quantity.
 */
function shapeVariant(variant, availability, { admin = false } = {}) {
  const stock = availability?.get(variant.id) || { physical: variant.stock_quantity, reserved: 0, available: variant.stock_quantity };
  return {
    id: variant.id,
    sku: variant.sku,
    price: Number(variant.price),
    compare_at_price: variant.compare_at_price == null ? null : Number(variant.compare_at_price),
    stock_quantity: admin ? stock.physical : stock.available,
    ...(admin ? { reserved_quantity: stock.reserved, available_quantity: stock.available } : {}),
    is_active: variant.is_active,
    in_stock: stock.available > 0,
    attributes: (variant.attributeValues || []).map((av) => ({
      name: av.attribute?.name,
      attribute_id: av.attribute_id,
      value: av.value,
    })),
    images: (variant.images || []).map((i) => ({ id: i.id, url: i.url, sort_order: i.sort_order })),
  };
}

function shapeProduct(product, { publicOnly = true, availability } = {}) {
  const variants = (product.variants || [])
    .filter((v) => (publicOnly ? v.is_active : true))
    .map((v) => shapeVariant(v, availability, { admin: !publicOnly }));
  const prices = variants.map((v) => v.price);
  const comparePrices = variants.map((v) => v.compare_at_price).filter((price) => price != null);
  return {
    id: product.id,
    name: product.name,
    slug: product.slug,
    description: product.description,
    base_price: Number(product.base_price),
    status: product.status,
    category: product.category
      ? { id: product.category.id, name: product.category.name, slug: product.category.slug }
      : null,
    price_from: prices.length ? Math.min(...prices) : Number(product.base_price),
    price_to: prices.length ? Math.max(...prices) : Number(product.base_price),
    compare_at_price_from: comparePrices.length ? Math.min(...comparePrices) : null,
    in_stock: variants.some((v) => v.in_stock),
    images: (product.images || [])
      .filter((i) => i.variant_id == null)
      .map((i) => ({ id: i.id, url: i.url, sort_order: i.sort_order }))
      .sort((a, b) => a.sort_order - b.sort_order),
    variants,
    created_at: product.created_at,
    updated_at: product.updated_at,
  };
}

/** Shapes products with reservation-aware stock (one availability query for the batch). */
async function shapeProducts(products, { publicOnly = true } = {}) {
  const availability = await inventory.availabilityFor(products.flatMap((p) => p.variants || []));
  return products.map((p) => shapeProduct(p, { publicOnly, availability }));
}

/* ----------------------------- Public cache ----------------------------- */

/*
 * Public reads cache product METADATA only (names, slugs, prices, images,
 * variant labels, status) through cache.service. Stock is never cached: every
 * response gets live available stock from MySQL (physical minus active holds)
 * merged in, so reservations, releases, expiries, payment commits, restocks
 * and admin stock edits show up immediately without any cache invalidation.
 * Catalog writes invalidate the metadata (see admin.catalog.service).
 */

// Slugs as utils/slug produces them. Anything else still goes to MySQL but
// never touches the cache, so random or malformed slugs cannot fill Redis.
const CACHEABLE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LIST_CACHE_MAX_QUERY = 40;
const LIST_CACHE_MAX_PAGE = 20;
const productNotFound = () => ApiError.notFound('Product not found', 'product_not_found');

/** Public DTO with stock fields present but empty (filled by withLiveStock). */
function publicMetadata(product) {
  const dto = shapeProduct(product, { publicOnly: true });
  dto.in_stock = null;
  for (const variant of dto.variants) {
    variant.stock_quantity = null;
    variant.in_stock = null;
  }
  return dto;
}

/** Fills live available stock into public DTOs (two indexed queries per batch). */
async function withLiveStock(products) {
  const ids = [...new Set(products.flatMap((p) => p.variants.map((v) => v.id)))];
  const variants = ids.length ? await db.ProductVariant.findAll({ where: { id: ids }, attributes: ['id', 'stock_quantity'] }) : [];
  const availability = await inventory.availabilityFor(variants);
  for (const product of products) {
    for (const variant of product.variants) {
      const available = availability.get(variant.id)?.available ?? 0;
      variant.stock_quantity = available;
      variant.in_stock = available > 0;
    }
    product.in_stock = product.variants.some((v) => v.in_stock);
  }
  return products;
}

async function listCategories() {
  return cache.readThrough('categories', async () => {
    const categories = await db.Category.findAll({
      include: [{ model: db.Product, as: 'products', where: { status: 'active' }, attributes: [], required: true }],
      order: [['name', 'ASC']],
      distinct: true,
    });
    return categories.map((category) => category.toJSON());
  });
}

async function getCategoryAttributes(categoryId) {
  const category = await db.Category.findByPk(categoryId, {
    include: [{ model: db.Attribute, as: 'attributes' }],
  });
  if (!category) throw ApiError.notFound('Category not found', 'category_not_found');
  return category.attributes;
}

async function listProducts({ category, q, page = 1, limit = 20, sort = 'newest', includeInactive = false }) {
  if (includeInactive) {
    const { rows, count } = await findProducts({ category, q, page, limit, sort, includeInactive });
    return {
      data: await shapeProducts(rows, { publicOnly: false }),
      pagination: { page, limit, total: count, pages: Math.ceil(count / limit) },
    };
  }
  // Canonical, bounded key: only the supported parameters, normalised; long
  // searches and deep pages skip the cache instead of minting new keys.
  const search = q ? q.trim().toLowerCase().replace(/\s+/g, ' ') : null;
  const params = { category: category || null, q: search, page, limit, sort };
  const cacheable = (!search || search.length <= LIST_CACHE_MAX_QUERY) && page <= LIST_CACHE_MAX_PAGE;
  const hash = crypto.createHash('sha256').update(JSON.stringify(params)).digest('hex').slice(0, 32);
  const result = await cache.readThrough(`products:list:${hash}`, async () => {
    const { rows, count } = await findProducts({ category, q, page, limit, sort });
    return {
      data: rows.map(publicMetadata),
      pagination: { page, limit, total: count, pages: Math.ceil(count / limit) },
    };
  }, { cacheable });
  await withLiveStock(result.data);
  return result;
}

async function findProducts({ category, q, page, limit, sort, includeInactive = false }) {
  const where = {};
  if (!includeInactive) where.status = 'active';
  if (q) where.name = { [Op.like]: `%${q}%` };

  const include = [...productInclude];
  if (category) {
    include[0] = {
      ...include[0],
      where: { slug: category },
      required: true,
    };
  }

  const order = {
    newest: [['created_at', 'DESC']],
    oldest: [['created_at', 'ASC']],
    name_asc: [['name', 'ASC']],
    name_desc: [['name', 'DESC']],
  }[sort] || [['created_at', 'DESC']];

  return db.Product.findAndCountAll({
    where,
    include,
    order,
    limit,
    offset: (page - 1) * limit,
    distinct: true,
  });
}

async function getProductBySlug(slug, { includeInactive = false } = {}) {
  if (includeInactive) {
    const product = await db.Product.findOne({ where: { slug }, include: productInclude });
    if (!product) throw productNotFound();
    return (await shapeProducts([product], { publicOnly: false }))[0];
  }
  // Missing and inactive slugs are cached briefly as "not found" (negative
  // cache); the catalog write that creates or activates them clears it at once.
  const dto = await cache.readThrough(`product:slug:${slug}`, async () => {
    const product = await db.Product.findOne({ where: { slug }, include: productInclude });
    if (!product || product.status !== 'active') throw productNotFound();
    return publicMetadata(product);
  }, { notFound: productNotFound, cacheable: slug.length <= 200 && CACHEABLE_SLUG.test(slug) });
  return (await withLiveStock([dto]))[0];
}

/**
 * Best-selling active products by units sold (non-cancelled orders), backfilled
 * with the newest active products so the section is never sparse.
 */
async function listBestsellers({ limit = 8 } = {}) {
  const sold = await db.sequelize.query(
    `SELECT pv.product_id AS id, SUM(oi.quantity) AS units
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id AND o.status <> 'cancelled'
     JOIN product_variants pv ON pv.id = oi.variant_id
     JOIN products p ON p.id = pv.product_id AND p.status = 'active'
     GROUP BY pv.product_id
     ORDER BY units DESC
     LIMIT :limit`,
    { type: db.Sequelize.QueryTypes.SELECT, replacements: { limit } }
  );
  let ids = sold.map((r) => r.id);

  if (ids.length < limit) {
    const fill = await db.Product.findAll({
      where: {
        status: 'active',
        ...(ids.length ? { id: { [Op.notIn]: ids } } : {}),
      },
      order: [['created_at', 'DESC']],
      limit: limit - ids.length,
      attributes: ['id'],
    });
    ids = ids.concat(fill.map((p) => p.id));
  }
  if (!ids.length) return [];

  const products = await db.Product.findAll({ where: { id: ids }, include: productInclude });
  const byId = new Map(products.map((p) => [p.id, p]));
  return shapeProducts(ids.map((id) => byId.get(id)).filter(Boolean), { publicOnly: true });
}

module.exports = {
  productInclude,
  shapeProduct,
  shapeProducts,
  shapeVariant,
  listCategories,
  getCategoryAttributes,
  listProducts,
  getProductBySlug,
  listBestsellers,
};
