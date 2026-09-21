'use strict';

const { DataTypes, Model } = require('sequelize');

module.exports = (sequelize) => {
  class LoyaltyTransaction extends Model {}
  LoyaltyTransaction.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      user_id: { type: DataTypes.INTEGER, allowNull: false },
      order_id: { type: DataTypes.INTEGER, allowNull: true },
      points: { type: DataTypes.INTEGER, allowNull: false },
      type: {
        type: DataTypes.ENUM('earn', 'redeem', 'expire', 'adjustment'),
        allowNull: false,
      },
      note: { type: DataTypes.STRING(255) },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    },
    {
      sequelize,
      modelName: 'LoyaltyTransaction',
      tableName: 'loyalty_transactions',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: false,
    }
  );

  return LoyaltyTransaction;
};
