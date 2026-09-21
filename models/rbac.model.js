'use strict';

const { DataTypes, Model } = require('sequelize');

module.exports = (sequelize) => {
  class Role extends Model {}
  Role.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      name: { type: DataTypes.STRING(50), allowNull: false, unique: true },
    },
    { sequelize, modelName: 'Role', tableName: 'roles', timestamps: false }
  );

  class Permission extends Model {}
  Permission.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      key: { type: DataTypes.STRING(80), allowNull: false, unique: true },
      label: { type: DataTypes.STRING(150), allowNull: false },
    },
    { sequelize, modelName: 'Permission', tableName: 'permissions', timestamps: false }
  );

  class RolePermission extends Model {}
  RolePermission.init(
    {
      role_id: { type: DataTypes.INTEGER, primaryKey: true },
      permission_id: { type: DataTypes.INTEGER, primaryKey: true },
    },
    { sequelize, modelName: 'RolePermission', tableName: 'role_permissions', timestamps: false }
  );

  class Staff extends Model {
    toSafeJSON() {
      const { password_hash, ...rest } = this.get({ plain: true });
      return rest;
    }
  }
  Staff.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      name: { type: DataTypes.STRING(120), allowNull: false },
      email: { type: DataTypes.STRING(190), allowNull: false, unique: true },
      password_hash: { type: DataTypes.STRING(255), allowNull: false },
      role_id: { type: DataTypes.INTEGER, allowNull: false },
      is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    },
    {
      sequelize,
      modelName: 'Staff',
      tableName: 'staff',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: false,
    }
  );

  return { Role, Permission, RolePermission, Staff };
};
