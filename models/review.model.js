'use strict';

const { DataTypes, Model } = require('sequelize');

module.exports = (sequelize) => {
  class Review extends Model {}
  Review.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      product_id: { type: DataTypes.INTEGER, allowNull: false },
      user_id: { type: DataTypes.INTEGER, allowNull: false },
      order_item_id: { type: DataTypes.INTEGER, allowNull: true },
      rating: {
        type: DataTypes.TINYINT,
        allowNull: false,
        validate: { min: 1, max: 5 },
      },
      title: { type: DataTypes.STRING(150) },
      body: { type: DataTypes.TEXT },
      status: {
        type: DataTypes.ENUM('pending', 'approved', 'rejected'),
        allowNull: false,
        defaultValue: 'pending',
      },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    },
    {
      sequelize,
      modelName: 'Review',
      tableName: 'reviews',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: false,
    }
  );

  return Review;
};
