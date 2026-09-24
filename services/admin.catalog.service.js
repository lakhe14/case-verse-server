'use strict';

const db = require('../models');
const ApiError = require('../utils/ApiError');
const { slugify } = require('../utils/slug');
const { productInclude, shapeProducts } = require('./catalog.service');
const inventory = require('./inventory.service');
const cache = require('./cache.service');

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

/*
 * Order lines and stock holds keep a hard reference to their variant, so a
 * variant (or a product owning one) with order history is never deleted:
 * staff deactivate it instead. The pre-check gives the business error; the
 * FK translation covers an order placed between the check and the delete.
 */
const IN_USE = {
  product: ['This product cannot be deleted because it is referenced by existing orders. Deactivate it instead.', 'product_in_use'],
  variant: ['This variant cannot be deleted because it is referenced by existing orders. Deactivate it instead.', 'variant_in_use'],
};

async function hasOrderHistory(variantIds) {
  if (!variantIds.length) return false;
  const where = { variant_id: { [db.Sequelize.Op.in]: variantIds } };
  const [items, holds] = await Promise.all([
    db.OrderItem.count({ where }),
    db.InventoryReservation.count({ where }),
  ]);
  return items + holds > 0;
}

async function destroyUnlessInUse(instance, kind) {
  try {
    await instance.destroy();
  } catch (error) {
    if (error.name === 'SequelizeForeignKeyConstraintError') throw ApiError.conflict(...IN_USE[kind]);
    throw error;
  }
}

async function deleteProduct(productId) {
  const product = await db.Product.findByPk(productId, { include: [{ model: db.ProductVariant, as: 'variants', attributes: ['id'] }] });
  if (!product) throw ApiError.notFound('Product not found', 'product_not_found');
  if (await hasOrderHistory(product.variants.map((v) => v.id))) throw ApiError.conflict(...IN_USE.product);
  await destroyUnlessInUse(product, 'product'); // cascades to variants/images via FK
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

async function updateVariant(productId, variantId, payload) {
  // Stock edits are checked against active reservations, so this runs at the
  // same isolation as order placement and locks the variant row first.
  return db.sequelize.transaction(inventory.STOCK_TX, async (t) => {
    const variant = await db.ProductVariant.findByPk(variantId, { lock: t.LOCK.UPDATE, transaction: t });
    if (!variant || variant.product_id !== productId) throw ApiError.notFound('Variant not found', 'variant_not_found');
    await variant.update(
      {
        sku: payload.sku ?? variant.sku,
        price: payload.price ?? variant.price,
        is_active: payload.is_active ?? variant.is_active,
      },
      { transaction: t }
    );
    // Physical stock goes only through the inventory service (reserved floor).
    if (payload.stock_quantity != null) await inventory.setPhysicalStock(variant.id, payload.stock_quantity, t);
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

async function deleteVariant(productId, variantId) {
  const variant = await db.ProductVariant.findByPk(variantId);
  if (!variant || variant.product_id !== productId) throw ApiError.notFound('Variant not found', 'variant_not_found');
  if (await hasOrderHistory([variant.id])) throw ApiError.conflict(...IN_USE.variant);
  await destroyUnlessInUse(variant, 'variant');
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
  return (await shapeProducts([product], { publicOnly: false }))[0];
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
    data: await shapeProducts(rows, { publicOnly: false }),
    pagination: { page, limit, total: count, pages: Math.ceil(count / limit) },
  };
}

// Every catalog write invalidates the public catalog cache once it has
// committed (each function below finishes its own transaction first), so the
// next storefront read sees it: details (old and new slug), lists, categories
// and cached "not found" markers alike. A failed write invalidates nothing.
const invalidatesCatalog = (fn) => async (...args) => {
  const result = await fn(...args);
  await cache.invalidateCatalog();
  return result;
};

module.exports = {
  createCategory: invalidatesCatalog(createCategory),
  createProduct: invalidatesCatalog(createProduct),
  updateProduct: invalidatesCatalog(updateProduct),
  deleteProduct: invalidatesCatalog(deleteProduct),
  createVariant: invalidatesCatalog(createVariant),
  updateVariant: invalidatesCatalog(updateVariant),
  deleteVariant: invalidatesCatalog(deleteVariant),
  addImages: invalidatesCatalog(addImages),
  deleteImage: invalidatesCatalog(deleteImage),
  loadProduct,
  adminListProducts,
  invalidatesCatalog,
};
