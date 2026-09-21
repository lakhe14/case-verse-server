'use strict';

const { DataTypes, Model } = require('sequelize');

module.exports = (sequelize) => {
  class Coupon extends Model {}
  Coupon.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      code: { type: DataTypes.STRING(40), allowNull: false, unique: true },
      description: { type: DataTypes.STRING(255) },
      discount_type: { type: DataTypes.ENUM('percentage', 'fixed'), allowNull: false },
      discount_value: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
      min_order_amount: { type: DataTypes.DECIMAL(10, 2), defaultValue: 0 },
      usage_limit_total: { type: DataTypes.INTEGER, allowNull: true },
      usage_limit_per_user: { type: DataTypes.INTEGER, allowNull: true, defaultValue: 1 },
      starts_at: { type: DataTypes.DATE, allowNull: true },
      ends_at: { type: DataTypes.DATE, allowNull: true },
      is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    },
    {
      sequelize,
      modelName: 'Coupon',
      tableName: 'coupons',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: false,
    }
  );

  class CouponUsage extends Model {}
  CouponUsage.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      coupon_id: { type: DataTypes.INTEGER, allowNull: false },
      user_id: { type: DataTypes.INTEGER, allowNull: false },
      order_id: { type: DataTypes.INTEGER, allowNull: false },
      used_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    },
    {
      sequelize,
      modelName: 'CouponUsage',
      tableName: 'coupon_usages',
      timestamps: true,
      createdAt: 'used_at',
      updatedAt: false,
    }
  );

  return { Coupon, CouponUsage };
};
