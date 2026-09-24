'use strict';

const { Op } = require('sequelize');
const db = require('../models');
const ApiError = require('../utils/ApiError');
const inventory = require('./inventory.service');

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

async function listCategories() {
  const categories = await db.Category.findAll({
    include: [{ model: db.Product, as: 'products', where: { status: 'active' }, attributes: [], required: true }],
    order: [['name', 'ASC']],
    distinct: true,
  });
  return categories;
}

async function getCategoryAttributes(categoryId) {
  const category = await db.Category.findByPk(categoryId, {
    include: [{ model: db.Attribute, as: 'attributes' }],
  });
  if (!category) throw ApiError.notFound('Category not found', 'category_not_found');
  return category.attributes;
}

async function listProducts({ category, q, page = 1, limit = 20, sort = 'newest', includeInactive = false }) {
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

  const { rows, count } = await db.Product.findAndCountAll({
    where,
    include,
    order,
    limit,
    offset: (page - 1) * limit,
    distinct: true,
  });

  return {
    data: await shapeProducts(rows, { publicOnly: !includeInactive }),
    pagination: { page, limit, total: count, pages: Math.ceil(count / limit) },
  };
}

async function getProductBySlug(slug, { includeInactive = false } = {}) {
  const product = await db.Product.findOne({ where: { slug }, include: productInclude });
  if (!product || (!includeInactive && product.status !== 'active')) {
    throw ApiError.notFound('Product not found', 'product_not_found');
  }
  return (await shapeProducts([product], { publicOnly: !includeInactive }))[0];
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
