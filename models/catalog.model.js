'use strict';

const { DataTypes, Model } = require('sequelize');

module.exports = (sequelize) => {
  class Category extends Model {}
  Category.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      name: { type: DataTypes.STRING(100), allowNull: false, unique: true },
      slug: { type: DataTypes.STRING(100), allowNull: false, unique: true },
    },
    { sequelize, modelName: 'Category', tableName: 'categories', timestamps: false }
  );

  class Product extends Model {}
  Product.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      category_id: { type: DataTypes.INTEGER, allowNull: false },
      name: { type: DataTypes.STRING(200), allowNull: false },
      slug: { type: DataTypes.STRING(220), allowNull: false, unique: true },
      description: { type: DataTypes.TEXT },
      base_price: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
      status: {
        type: DataTypes.ENUM('active', 'inactive', 'draft'),
        allowNull: false,
        defaultValue: 'active',
      },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    },
    {
      sequelize,
      modelName: 'Product',
      tableName: 'products',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    }
  );

  class Attribute extends Model {}
  Attribute.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      name: { type: DataTypes.STRING(80), allowNull: false, unique: true },
    },
    { sequelize, modelName: 'Attribute', tableName: 'attributes', timestamps: false }
  );

  class CategoryAttribute extends Model {}
  CategoryAttribute.init(
    {
      category_id: { type: DataTypes.INTEGER, primaryKey: true },
      attribute_id: { type: DataTypes.INTEGER, primaryKey: true },
    },
    { sequelize, modelName: 'CategoryAttribute', tableName: 'category_attributes', timestamps: false }
  );

  class ProductVariant extends Model {}
  ProductVariant.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      product_id: { type: DataTypes.INTEGER, allowNull: false },
      sku: { type: DataTypes.STRING(64), allowNull: false, unique: true },
      price: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
      stock_quantity: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    },
    {
      sequelize,
      modelName: 'ProductVariant',
      tableName: 'product_variants',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: false,
    }
  );

  class VariantAttributeValue extends Model {}
  VariantAttributeValue.init(
    {
      variant_id: { type: DataTypes.INTEGER, primaryKey: true },
      attribute_id: { type: DataTypes.INTEGER, primaryKey: true },
      value: { type: DataTypes.STRING(150), allowNull: false },
    },
    {
      sequelize,
      modelName: 'VariantAttributeValue',
      tableName: 'variant_attribute_values',
      timestamps: false,
    }
  );

  class ProductImage extends Model {}
  ProductImage.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      product_id: { type: DataTypes.INTEGER, allowNull: false },
      variant_id: { type: DataTypes.INTEGER, allowNull: true },
      url: { type: DataTypes.STRING(500), allowNull: false },
      sort_order: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    },
    { sequelize, modelName: 'ProductImage', tableName: 'product_images', timestamps: false }
  );

  return {
    Category,
    Product,
    Attribute,
    CategoryAttribute,
    ProductVariant,
    VariantAttributeValue,
    ProductImage,
  };
};
