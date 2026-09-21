'use strict';

const { DataTypes, Model } = require('sequelize');

module.exports = (sequelize) => {
  class ShippingRate extends Model {}
  ShippingRate.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      zone_name: { type: DataTypes.STRING(100), allowNull: false },
      method_name: { type: DataTypes.STRING(100), allowNull: false },
      cost: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
      free_above_amount: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
      is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    },
    { sequelize, modelName: 'ShippingRate', tableName: 'shipping_rates', timestamps: false }
  );

  // Note: schema.sql still defines a `tax_rates` table, but the store does not
  // charge sales tax, so there is no model or code path for it.

  class StoreSetting extends Model {}
  StoreSetting.init(
    {
      key: { type: DataTypes.STRING(80), primaryKey: true },
      value: { type: DataTypes.STRING(500), allowNull: false },
    },
    { sequelize, modelName: 'StoreSetting', tableName: 'store_settings', timestamps: false }
  );

  return { ShippingRate, StoreSetting };
};
