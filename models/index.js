'use strict';

const { sequelize } = require('../config/database');

const User = require('./user.model')(sequelize);
const PasswordReset = require('./passwordReset.model')(sequelize);
const Address = require('./address.model')(sequelize);
const { Role, Permission, RolePermission, Staff } = require('./rbac.model')(sequelize);
const {
  Category,
  Product,
  Attribute,
  CategoryAttribute,
  ProductVariant,
  VariantAttributeValue,
  ProductImage,
} = require('./catalog.model')(sequelize);
const { Cart, CartItem, Wishlist } = require('./cart.model')(sequelize);
const { Coupon, CouponUsage } = require('./coupon.model')(sequelize);
const { Order, OrderItem, OrderStatusHistory, OrderPaymentConfirmation, OrderPromoItem, GuestOrderToken, GuestOrderIdempotency } = require('./order.model')(sequelize);
const Review = require('./review.model')(sequelize);
const LoyaltyTransaction = require('./loyalty.model')(sequelize);
const { ShippingRate, StoreSetting } = require('./settings.model')(sequelize);

/* ----------------------------- Associations ----------------------------- */

// Users
User.hasMany(PasswordReset, { foreignKey: 'user_id', as: 'passwordResets' });
PasswordReset.belongsTo(User, { foreignKey: 'user_id', as: 'user' });

User.hasMany(Address, { foreignKey: 'user_id', as: 'addresses' });
Address.belongsTo(User, { foreignKey: 'user_id', as: 'user' });

// RBAC
Role.hasMany(Staff, { foreignKey: 'role_id', as: 'staff' });
Staff.belongsTo(Role, { foreignKey: 'role_id', as: 'role' });

Role.belongsToMany(Permission, {
  through: RolePermission,
  foreignKey: 'role_id',
  otherKey: 'permission_id',
  as: 'permissions',
});
Permission.belongsToMany(Role, {
  through: RolePermission,
  foreignKey: 'permission_id',
  otherKey: 'role_id',
  as: 'roles',
});

// Catalog
Category.hasMany(Product, { foreignKey: 'category_id', as: 'products' });
Product.belongsTo(Category, { foreignKey: 'category_id', as: 'category' });

Category.belongsToMany(Attribute, {
  through: CategoryAttribute,
  foreignKey: 'category_id',
  otherKey: 'attribute_id',
  as: 'attributes',
});
Attribute.belongsToMany(Category, {
  through: CategoryAttribute,
  foreignKey: 'attribute_id',
  otherKey: 'category_id',
  as: 'categories',
});

Product.hasMany(ProductVariant, { foreignKey: 'product_id', as: 'variants' });
ProductVariant.belongsTo(Product, { foreignKey: 'product_id', as: 'product' });

Product.hasMany(ProductImage, { foreignKey: 'product_id', as: 'images' });
ProductImage.belongsTo(Product, { foreignKey: 'product_id', as: 'product' });
ProductVariant.hasMany(ProductImage, { foreignKey: 'variant_id', as: 'images' });
ProductImage.belongsTo(ProductVariant, { foreignKey: 'variant_id', as: 'variant' });

ProductVariant.hasMany(VariantAttributeValue, { foreignKey: 'variant_id', as: 'attributeValues' });
VariantAttributeValue.belongsTo(ProductVariant, { foreignKey: 'variant_id', as: 'variant' });
VariantAttributeValue.belongsTo(Attribute, { foreignKey: 'attribute_id', as: 'attribute' });
Attribute.hasMany(VariantAttributeValue, { foreignKey: 'attribute_id', as: 'variantValues' });

// Cart & wishlist
User.hasOne(Cart, { foreignKey: 'user_id', as: 'cart' });
Cart.belongsTo(User, { foreignKey: 'user_id', as: 'user' });
Cart.hasMany(CartItem, { foreignKey: 'cart_id', as: 'items' });
CartItem.belongsTo(Cart, { foreignKey: 'cart_id', as: 'cart' });
CartItem.belongsTo(ProductVariant, { foreignKey: 'variant_id', as: 'variant' });

User.hasMany(Wishlist, { foreignKey: 'user_id', as: 'wishlist' });
Wishlist.belongsTo(User, { foreignKey: 'user_id', as: 'user' });
Wishlist.belongsTo(Product, { foreignKey: 'product_id', as: 'product' });
Product.hasMany(Wishlist, { foreignKey: 'product_id', as: 'wishlistedBy' });

// Coupons
Coupon.hasMany(CouponUsage, { foreignKey: 'coupon_id', as: 'usages' });
CouponUsage.belongsTo(Coupon, { foreignKey: 'coupon_id', as: 'coupon' });
CouponUsage.belongsTo(User, { foreignKey: 'user_id', as: 'user' });
CouponUsage.belongsTo(Order, { foreignKey: 'order_id', as: 'order' });

// Orders
User.hasMany(Order, { foreignKey: 'user_id', as: 'orders' });
Order.belongsTo(User, { foreignKey: 'user_id', as: 'user' });
Order.belongsTo(Coupon, { foreignKey: 'coupon_id', as: 'coupon' });
Order.belongsTo(Address, { foreignKey: 'shipping_address_id', as: 'shippingAddress' });
Order.belongsTo(Address, { foreignKey: 'billing_address_id', as: 'billingAddress' });

Order.hasMany(OrderItem, { foreignKey: 'order_id', as: 'items' });
OrderItem.belongsTo(Order, { foreignKey: 'order_id', as: 'order' });
OrderItem.belongsTo(ProductVariant, { foreignKey: 'variant_id', as: 'variant' });

Order.hasMany(OrderStatusHistory, { foreignKey: 'order_id', as: 'statusHistory' });
OrderStatusHistory.belongsTo(Order, { foreignKey: 'order_id', as: 'order' });
OrderStatusHistory.belongsTo(Staff, { foreignKey: 'changed_by_staff_id', as: 'changedByStaff' });
Order.hasOne(OrderPaymentConfirmation, { foreignKey: 'order_id', as: 'paymentConfirmation' });
OrderPaymentConfirmation.belongsTo(Order, { foreignKey: 'order_id', as: 'order' });
OrderPaymentConfirmation.belongsTo(Staff, { foreignKey: 'reviewed_by_staff_id', as: 'reviewedByStaff' });

Order.hasMany(OrderPromoItem, { foreignKey: 'order_id', as: 'promoItems' });
OrderPromoItem.belongsTo(Order, { foreignKey: 'order_id', as: 'order' });

Order.hasOne(GuestOrderToken, { foreignKey: 'order_id', as: 'guestToken' });
GuestOrderToken.belongsTo(Order, { foreignKey: 'order_id', as: 'order' });
GuestOrderIdempotency.belongsTo(Order, { foreignKey: 'order_id', as: 'order' });

// Reviews
Product.hasMany(Review, { foreignKey: 'product_id', as: 'reviews' });
Review.belongsTo(Product, { foreignKey: 'product_id', as: 'product' });
Review.belongsTo(User, { foreignKey: 'user_id', as: 'user' });
Review.belongsTo(OrderItem, { foreignKey: 'order_item_id', as: 'orderItem' });

// Loyalty
User.hasMany(LoyaltyTransaction, { foreignKey: 'user_id', as: 'loyaltyTransactions' });
LoyaltyTransaction.belongsTo(User, { foreignKey: 'user_id', as: 'user' });
LoyaltyTransaction.belongsTo(Order, { foreignKey: 'order_id', as: 'order' });

const db = {
  sequelize,
  Sequelize: require('sequelize'),
  User,
  PasswordReset,
  Address,
  Role,
  Permission,
  RolePermission,
  Staff,
  Category,
  Product,
  Attribute,
  CategoryAttribute,
  ProductVariant,
  VariantAttributeValue,
  ProductImage,
  Cart,
  CartItem,
  Wishlist,
  Coupon,
  CouponUsage,
  Order,
  OrderItem,
  OrderStatusHistory,
  OrderPaymentConfirmation,
  OrderPromoItem,
  GuestOrderToken,
  GuestOrderIdempotency,
  Review,
  LoyaltyTransaction,
  ShippingRate,
  StoreSetting,
};

module.exports = db;
