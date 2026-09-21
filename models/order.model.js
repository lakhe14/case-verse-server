'use strict';

const { DataTypes, Model } = require('sequelize');

const ORDER_STATUSES = ['pending', 'processing', 'shipped', 'delivered', 'cancelled'];

module.exports = (sequelize) => {
  class Order extends Model {}
  Order.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      order_number: { type: DataTypes.STRING(30), allowNull: false, unique: true },
      user_id: { type: DataTypes.INTEGER, allowNull: false },
      status: {
        type: DataTypes.ENUM(...ORDER_STATUSES),
        allowNull: false,
        defaultValue: 'pending',
      },
      subtotal_amount: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
      discount_amount: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
      bundle_discount_amount: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
      tax_amount: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
      shipping_amount: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
      total_amount: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
      coupon_id: { type: DataTypes.INTEGER, allowNull: true },
      shipping_address_id: { type: DataTypes.INTEGER, allowNull: false },
      billing_address_id: { type: DataTypes.INTEGER, allowNull: false },
      placed_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    },
    {
      sequelize,
      modelName: 'Order',
      tableName: 'orders',
      timestamps: true,
      createdAt: 'placed_at',
      updatedAt: false,
    }
  );

  class OrderItem extends Model {}
  OrderItem.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      order_id: { type: DataTypes.INTEGER, allowNull: false },
      variant_id: { type: DataTypes.INTEGER, allowNull: false },
      product_name_snap: { type: DataTypes.STRING(200), allowNull: false },
      sku_snap: { type: DataTypes.STRING(64), allowNull: false },
      unit_price: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
      quantity: { type: DataTypes.INTEGER, allowNull: false },
      line_total: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
    },
    { sequelize, modelName: 'OrderItem', tableName: 'order_items', timestamps: false }
  );

  class OrderStatusHistory extends Model {}
  OrderStatusHistory.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      order_id: { type: DataTypes.INTEGER, allowNull: false },
      status: { type: DataTypes.ENUM(...ORDER_STATUSES), allowNull: false },
      changed_by_staff_id: { type: DataTypes.INTEGER, allowNull: true },
      note: { type: DataTypes.STRING(255) },
      changed_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    },
    {
      sequelize,
      modelName: 'OrderStatusHistory',
      tableName: 'order_status_history',
      timestamps: true,
      createdAt: 'changed_at',
      updatedAt: false,
    }
  );

  class OrderPaymentConfirmation extends Model {}
  OrderPaymentConfirmation.init({
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true }, order_id: { type: DataTypes.INTEGER, allowNull: false, unique: true },
    method: { type: DataTypes.ENUM('advance_qr', 'whatsapp_cod'), allowNull: false }, advance_amount: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 100 },
    status: { type: DataTypes.ENUM('pending', 'proof_uploaded', 'approved', 'rejected', 'cod_pending', 'cod_confirmed'), allowNull: false, defaultValue: 'pending' }, proof_filename: { type: DataTypes.STRING(255) }, admin_note: { type: DataTypes.STRING(500) }, reviewed_by_staff_id: { type: DataTypes.INTEGER }, reviewed_at: { type: DataTypes.DATE },
  }, { sequelize, modelName: 'OrderPaymentConfirmation', tableName: 'order_payment_confirmations', timestamps: true, createdAt: 'created_at', updatedAt: 'updated_at' });
  return { Order, OrderItem, OrderStatusHistory, OrderPaymentConfirmation };
};

module.exports.ORDER_STATUSES = ORDER_STATUSES;
