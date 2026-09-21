'use strict';

const db = require('../models');
const ApiError = require('../utils/ApiError');
const { slugify } = require('../utils/slug');
const { productInclude, shapeProduct } = require('./catalog.service');

/* ------------------------------ Categories ------------------------------ */

async function createCategory({ name, slug, attribute_ids = [] }) {
  const finalSlug = slug ? slugify(slug) : slugify(name);
  return db.sequelize.transaction(async (t) => {
    const category = await db.Category.create({ name, slug: finalSlug }, { transaction: t });
    if (attribute_ids.length) {
      await db.CategoryAttribute.bulkCreate(
        attribute_ids.map((attribute_id) => ({ category_id: category.id, attribute_id })),
        { transaction: t }
      );
    }
    return category;
  });
}

/* ------------------------------- Products ------------------------------- */

async function ensureUniqueSlug(base, excludeId) {
  let slug = base;
  let n = 1;
  // eslint-disable-next-line no-await-in-loop
  while (true) {
    const clash = await db.Product.findOne({ where: { slug } });
    if (!clash || clash.id === excludeId) return slug;
    n += 1;
    slug = `${base}-${n}`;
  }
}

async function createProduct(payload) {
  const category = await db.Category.findByPk(payload.category_id);
  if (!category) throw ApiError.badRequest('Category not found', 'category_not_found');

  const baseSlug = payload.slug ? slugify(payload.slug) : slugify(payload.name);
  const slug = await ensureUniqueSlug(baseSlug);

  return db.sequelize.transaction(async (t) => {
    const product = await db.Product.create(
      {
        category_id: payload.category_id,
        name: payload.name,
        slug,
        description: payload.description ?? null,
        base_price: payload.base_price,
        status: payload.status || 'active',
      },
      { transaction: t }
    );

    for (const v of payload.variants || []) {
      // eslint-disable-next-line no-await-in-loop
      await createVariantInternal(product.id, v, t);
    }

    return loadProduct(product.id, t);
  });
}

async function updateProduct(productId, payload) {
  const product = await db.Product.findByPk(productId);
  if (!product) throw ApiError.notFound('Product not found', 'product_not_found');

  if (payload.category_id) {
    const category = await db.Category.findByPk(payload.category_id);
    if (!category) throw ApiError.badRequest('Category not found', 'category_not_found');
  }

  const patch = { ...payload };
  if (payload.slug || payload.name) {
    const base = slugify(payload.slug || payload.name || product.name);
    patch.slug = await ensureUniqueSlug(base, product.id);
  }
  await product.update(patch);
  return loadProduct(product.id);
}

async function deleteProduct(productId) {
  const product = await db.Product.findByPk(productId);
  if (!product) throw ApiError.notFound('Product not found', 'product_not_found');
  await product.destroy(); // cascades to variants/images via FK
}

/* ------------------------------- Variants ------------------------------- */

async function createVariantInternal(productId, v, transaction) {
  const variant = await db.ProductVariant.create(
    {
      product_id: productId,
      sku: v.sku,
      price: v.price,
      stock_quantity: v.stock_quantity ?? 0,
      is_active: v.is_active ?? true,
    },
    { transaction }
  );
  if (v.attributes && v.attributes.length) {
    await db.VariantAttributeValue.bulkCreate(
      v.attributes.map((a) => ({
        variant_id: variant.id,
        attribute_id: a.attribute_id,
        value: a.value,
      })),
      { transaction }
    );
  }
  return variant;
}

async function createVariant(productId, payload) {
  const product = await db.Product.findByPk(productId);
  if (!product) throw ApiError.notFound('Product not found', 'product_not_found');
  return db.sequelize.transaction(async (t) => {
    await createVariantInternal(productId, payload, t);
    return loadProduct(productId, t);
  });
}

async function updateVariant(variantId, payload) {
  const variant = await db.ProductVariant.findByPk(variantId);
  if (!variant) throw ApiError.notFound('Variant not found', 'variant_not_found');
  return db.sequelize.transaction(async (t) => {
    await variant.update(
      {
        sku: payload.sku ?? variant.sku,
        price: payload.price ?? variant.price,
        stock_quantity: payload.stock_quantity ?? variant.stock_quantity,
        is_active: payload.is_active ?? variant.is_active,
      },
      { transaction: t }
    );
    if (payload.attributes) {
      await db.VariantAttributeValue.destroy({ where: { variant_id: variantId }, transaction: t });
      if (payload.attributes.length) {
        await db.VariantAttributeValue.bulkCreate(
          payload.attributes.map((a) => ({
            variant_id: variantId,
            attribute_id: a.attribute_id,
            value: a.value,
          })),
          { transaction: t }
        );
      }
    }
    return loadProduct(variant.product_id, t);
  });
}

async function deleteVariant(variantId) {
  const variant = await db.ProductVariant.findByPk(variantId);
  if (!variant) throw ApiError.notFound('Variant not found', 'variant_not_found');
  await variant.destroy();
}

/* -------------------------------- Images -------------------------------- */

async function addImages(productId, files, { variant_id } = {}) {
  const product = await db.Product.findByPk(productId);
  if (!product) throw ApiError.notFound('Product not found', 'product_not_found');

  const existingCount = await db.ProductImage.count({ where: { product_id: productId } });
  const rows = files.map((file, i) => ({
    product_id: productId,
    variant_id: variant_id || null,
    url: `/uploads/${file.filename}`,
    sort_order: existingCount + i,
  }));
  await db.ProductImage.bulkCreate(rows);
  return loadProduct(productId);
}

async function deleteImage(imageId) {
  const image = await db.ProductImage.findByPk(imageId);
  if (!image) throw ApiError.notFound('Image not found', 'image_not_found');
  await image.destroy();
}

/* -------------------------------- Shared -------------------------------- */

async function loadProduct(productId, transaction) {
  const product = await db.Product.findByPk(productId, { include: productInclude, transaction });
  return shapeProduct(product, { publicOnly: false });
}

async function adminListProducts({ page = 1, limit = 20, q, status } = {}) {
  const where = {};
  if (status) where.status = status;
  if (q) where.name = { [db.Sequelize.Op.like]: `%${q}%` };
  const { rows, count } = await db.Product.findAndCountAll({
    where,
    include: productInclude,
    order: [['created_at', 'DESC']],
    limit,
    offset: (page - 1) * limit,
    distinct: true,
  });
  return {
    data: rows.map((p) => shapeProduct(p, { publicOnly: false })),
    pagination: { page, limit, total: count, pages: Math.ceil(count / limit) },
  };
}

module.exports = {
  createCategory,
  createProduct,
  updateProduct,
  deleteProduct,
  createVariant,
  updateVariant,
  deleteVariant,
  addImages,
  deleteImage,
  loadProduct,
  adminListProducts,
};
