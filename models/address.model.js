'use strict';

const { DataTypes, Model } = require('sequelize');

module.exports = (sequelize) => {
  class Address extends Model {}

  Address.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      user_id: { type: DataTypes.INTEGER, allowNull: false },
      label: { type: DataTypes.STRING(50), defaultValue: 'Home' },
      recipient_name: { type: DataTypes.STRING(120), allowNull: false },
      phone: { type: DataTypes.STRING(20), allowNull: false },
      line1: { type: DataTypes.STRING(255), allowNull: false },
      line2: { type: DataTypes.STRING(255) },
      city: { type: DataTypes.STRING(100), allowNull: false },
      state: { type: DataTypes.STRING(100) },
      postal_code: { type: DataTypes.STRING(20) },
      country: { type: DataTypes.STRING(100), allowNull: false, defaultValue: 'Nepal' },
      is_default: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    },
    {
      sequelize,
      modelName: 'Address',
      tableName: 'addresses',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: false,
    }
  );

  return Address;
};
