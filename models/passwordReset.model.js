'use strict';

const { DataTypes, Model } = require('sequelize');

module.exports = (sequelize) => {
  class PasswordReset extends Model {}

  PasswordReset.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      user_id: { type: DataTypes.INTEGER, allowNull: false },
      token_hash: { type: DataTypes.STRING(255), allowNull: false },
      expires_at: { type: DataTypes.DATE, allowNull: false },
      used_at: { type: DataTypes.DATE, allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    },
    {
      sequelize,
      modelName: 'PasswordReset',
      tableName: 'password_resets',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: false,
    }
  );

  return PasswordReset;
};
