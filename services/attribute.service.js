'use strict';

const db = require('../models');
const ApiError = require('../utils/ApiError');
const cache = require('./cache.service');

/**
 * List every attribute, each with the distinct values already used across all
 * variants (handy for powering datalists / dropdowns in the admin UI).
 */
async function listAttributes() {
  const attributes = await db.Attribute.findAll({ order: [['name', 'ASC']] });

  const valueRows = await db.VariantAttributeValue.findAll({
    attributes: ['attribute_id', 'value'],
    group: ['attribute_id', 'value'],
    order: [['attribute_id', 'ASC'], ['value', 'ASC']],
    raw: true,
  });
  const valuesByAttr = valueRows.reduce((acc, row) => {
    (acc[row.attribute_id] ||= []).push(row.value);
    return acc;
  }, {});

  return attributes.map((a) => ({
    id: a.id,
    name: a.name,
    values: valuesByAttr[a.id] || [],
  }));
}

async function createAttribute({ name }) {
  const trimmed = name.trim();
  const existing = await db.Attribute.findOne({ where: { name: trimmed } });
  if (existing) throw ApiError.conflict('An attribute with that name already exists', 'attribute_exists');
  return db.Attribute.create({ name: trimmed });
}

async function renameAttribute(attributeId, { name }) {
  const attribute = await db.Attribute.findByPk(attributeId);
  if (!attribute) throw ApiError.notFound('Attribute not found', 'attribute_not_found');
  const trimmed = name.trim();
  const clash = await db.Attribute.findOne({ where: { name: trimmed } });
  if (clash && clash.id !== attribute.id) {
    throw ApiError.conflict('An attribute with that name already exists', 'attribute_exists');
  }
  await attribute.update({ name: trimmed });
  return attribute;
}

async function deleteAttribute(attributeId) {
  const attribute = await db.Attribute.findByPk(attributeId);
  if (!attribute) throw ApiError.notFound('Attribute not found', 'attribute_not_found');
  const inUse = await db.VariantAttributeValue.count({ where: { attribute_id: attributeId } });
  if (inUse > 0) {
    throw ApiError.conflict(
      `Attribute is used by ${inUse} variant value(s); clear those first`,
      'attribute_in_use'
    );
  }
  await attribute.destroy(); // category_attributes rows cascade
}

/** Categories with the attributes assigned to each (for the admin taxonomy screen). */
async function listCategoriesWithAttributes() {
  const categories = await db.Category.findAll({
    include: [{ model: db.Attribute, as: 'attributes', through: { attributes: [] } }],
    order: [['name', 'ASC']],
  });
  return categories.map((c) => ({
    id: c.id,
    name: c.name,
    slug: c.slug,
    attribute_ids: (c.attributes || []).map((a) => a.id),
    attributes: (c.attributes || []).map((a) => ({ id: a.id, name: a.name })),
  }));
}

/** Replace the full set of attribute links for one category. */
async function setCategoryAttributes(categoryId, attributeIds) {
  const category = await db.Category.findByPk(categoryId);
  if (!category) throw ApiError.notFound('Category not found', 'category_not_found');

  const attributes = await db.Attribute.findAll({ where: { id: attributeIds } });
  if (attributes.length !== attributeIds.length) {
    throw ApiError.badRequest('One or more attributes do not exist', 'unknown_attribute');
  }
  await category.setAttributes(attributes);
  return listCategoriesWithAttributes().then((all) => all.find((c) => c.id === category.id));
}

// Attribute names appear in public variant data: renames and deletes
// invalidate the public catalog cache after they commit.
const afterWrite = (fn) => async (...args) => {
  const result = await fn(...args);
  await cache.invalidateCatalog();
  return result;
};

module.exports = {
  listAttributes,
  createAttribute: afterWrite(createAttribute),
  renameAttribute: afterWrite(renameAttribute),
  deleteAttribute: afterWrite(deleteAttribute),
  listCategoriesWithAttributes,
  setCategoryAttributes: afterWrite(setCategoryAttributes),
};
