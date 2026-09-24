'use strict';

const { DataTypes, Model } = require('sequelize');

const ORDER_STATUSES = ['pending', 'processing', 'shipped', 'delivered', 'cancelled'];
// payment_timeout = cancelled by the system after the unpaid order's stock hold expired.
const CANCELLATION_REASONS = ['customer', 'guest', 'staff', 'payment_timeout'];

module.exports = (sequelize) => {
  class Order extends Model {}
  Order.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      order_number: { type: DataTypes.STRING(30), allowNull: false, unique: true },
      user_id: { type: DataTypes.INTEGER, allowNull: true },
      guest_name: { type: DataTypes.STRING(120), allowNull: true },
      guest_phone: { type: DataTypes.STRING(20), allowNull: true },
      guest_province: { type: DataTypes.STRING(100), allowNull: true },
      guest_district: { type: DataTypes.STRING(100), allowNull: true },
      guest_municipality: { type: DataTypes.STRING(150), allowNull: true },
      guest_area: { type: DataTypes.STRING(255), allowNull: true },
      guest_landmark: { type: DataTypes.STRING(255), allowNull: true },
      guest_delivery_notes: { type: DataTypes.STRING(500), allowNull: true },
      guest_latitude: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
      guest_longitude: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
      status: {
        type: DataTypes.ENUM(...ORDER_STATUSES),
        allowNull: false,
        defaultValue: 'pending',
      },
      subtotal_amount: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
      discount_amount: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
      bundle_discount_amount: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
      campaign_code: { type: DataTypes.STRING(40), allowNull: true },
      campaign_name_snap: { type: DataTypes.STRING(150), allowNull: true },
      tax_amount: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
      shipping_amount: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
      courier_provider: { type: DataTypes.STRING(50), allowNull: true },
      courier_destination_id: { type: DataTypes.STRING(100), allowNull: true },
      courier_destination_name: { type: DataTypes.STRING(200), allowNull: true },
      courier_service_type: { type: DataTypes.STRING(50), allowNull: true },
      courier_weight_kg: { type: DataTypes.DECIMAL(10, 3), allowNull: true },
      courier_base_charge: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
      courier_weight_surcharge: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
      courier_delivery_charge: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
      courier_rate_basis: { type: DataTypes.STRING(255), allowNull: true },
      courier_valley: { type: DataTypes.STRING(50), allowNull: true },
      total_amount: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
      coupon_id: { type: DataTypes.INTEGER, allowNull: true },
      shipping_address_id: { type: DataTypes.INTEGER, allowNull: true },
      billing_address_id: { type: DataTypes.INTEGER, allowNull: true },
      // Who or what cancelled the order (CANCELLATION_REASONS); NULL otherwise.
      cancellation_reason: { type: DataTypes.STRING(40), allowNull: true },
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

  // Free promotional items (e.g. the Dashain suction holder) have no catalogue
  // SKU, so they are snapshotted here rather than forced into order_items,
  // which requires a real variant_id.
  class OrderPromoItem extends Model {}
  OrderPromoItem.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      order_id: { type: DataTypes.INTEGER, allowNull: false },
      sku_snap: { type: DataTypes.STRING(64), allowNull: false },
      name_snap: { type: DataTypes.STRING(200), allowNull: false },
      quantity: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
      unit_price: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
    },
    {
      sequelize,
      modelName: 'OrderPromoItem',
      tableName: 'order_promo_items',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: false,
    }
  );

  // Secure guest order access. Only the token's sha256 hash lives here — the
  // raw token is returned once, at order creation, and never stored or logged.
  class GuestOrderToken extends Model {}
  GuestOrderToken.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      order_id: { type: DataTypes.INTEGER, allowNull: false, unique: true },
      token_hash: { type: DataTypes.STRING(255), allowNull: false, unique: true },
    },
    {
      sequelize,
      modelName: 'GuestOrderToken',
      tableName: 'guest_order_tokens',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: false,
    }
  );

  // One row per guest checkout submission. Only hashes and a sealed replay
  // token are stored (see services/guestIdempotency.js).
  class GuestOrderIdempotency extends Model {}
  GuestOrderIdempotency.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      key_hash: { type: DataTypes.CHAR(64), allowNull: false, unique: 'uq_guest_idem_key' },
      request_fingerprint: { type: DataTypes.CHAR(64), allowNull: false },
      order_id: { type: DataTypes.INTEGER, allowNull: true },
      replay_token_sealed: { type: DataTypes.STRING(255), allowNull: true },
      expires_at: { type: DataTypes.DATE, allowNull: false },
    },
    {
      sequelize,
      modelName: 'GuestOrderIdempotency',
      tableName: 'guest_order_idempotency',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: false,
    }
  );

  // Stock held for an unconfirmed order line (see services/inventory.service.js).
  class InventoryReservation extends Model {}
  InventoryReservation.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      order_id: { type: DataTypes.INTEGER, allowNull: false },
      variant_id: { type: DataTypes.INTEGER, allowNull: false },
      quantity: { type: DataTypes.INTEGER, allowNull: false },
      status: { type: DataTypes.ENUM('active', 'committed', 'released', 'expired', 'restocked'), allowNull: false, defaultValue: 'active' },
      // NULL while a payment proof awaits staff review: the hold has no deadline.
      expires_at: { type: DataTypes.DATE, allowNull: true },
    },
    {
      sequelize,
      modelName: 'InventoryReservation',
      tableName: 'inventory_reservations',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    }
  );

  return { Order, OrderItem, OrderStatusHistory, OrderPaymentConfirmation, OrderPromoItem, GuestOrderToken, GuestOrderIdempotency, InventoryReservation };
};

module.exports.ORDER_STATUSES = ORDER_STATUSES;
module.exports.CANCELLATION_REASONS = CANCELLATION_REASONS;
