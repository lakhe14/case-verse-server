-- AUTHORITATIVE schema for the CaseVerse API (server/db/schema.sql).
-- Used by scripts/initDb.js and the isolated E2E setup. Column additions made
-- by scripts/migrate*.js still run after it and are idempotent.
-- ============================================================
-- E-commerce DB Schema (MySQL 8+) — category-extensible iPhone covers store
-- Engine: InnoDB, Charset: utf8mb4
-- ============================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- ============================================================
-- 1. USERS, AUTH, ADDRESSES
-- ============================================================

CREATE TABLE users (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    name            VARCHAR(120)    NOT NULL,
    email           VARCHAR(190)    NOT NULL UNIQUE,
    password_hash   VARCHAR(255)    NOT NULL,
    phone           VARCHAR(20),
    loyalty_points  INT             NOT NULL DEFAULT 0,   -- cached balance; ledger below is source of truth
    is_active       TINYINT(1)      NOT NULL DEFAULT 1,
    created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE password_resets (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    user_id     INT NOT NULL,
    token_hash  VARCHAR(255) NOT NULL,
    expires_at  DATETIME NOT NULL,
    used_at     DATETIME NULL,
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE addresses (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    user_id         INT NOT NULL,
    label           VARCHAR(50)     DEFAULT 'Home',   -- Home / Office / etc
    recipient_name  VARCHAR(120)    NOT NULL,
    phone           VARCHAR(20)     NOT NULL,
    line1           VARCHAR(255)    NOT NULL,
    line2           VARCHAR(255),
    city            VARCHAR(100)    NOT NULL,
    state           VARCHAR(100),
    postal_code     VARCHAR(20),
    country         VARCHAR(100)    NOT NULL DEFAULT 'Nepal',
    is_default      TINYINT(1)      NOT NULL DEFAULT 0,
    created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ============================================================
-- 2. STAFF, ROLES, PERMISSIONS (admin dashboard access control)
-- ============================================================

CREATE TABLE roles (
    id      INT AUTO_INCREMENT PRIMARY KEY,
    name    VARCHAR(50) NOT NULL UNIQUE   -- e.g. Super Admin, Product Manager, Support
) ENGINE=InnoDB;

CREATE TABLE permissions (
    id      INT AUTO_INCREMENT PRIMARY KEY,
    `key`   VARCHAR(80) NOT NULL UNIQUE,  -- e.g. manage_products, manage_orders, manage_coupons, view_analytics
    label   VARCHAR(150) NOT NULL
) ENGINE=InnoDB;

CREATE TABLE role_permissions (
    role_id         INT NOT NULL,
    permission_id   INT NOT NULL,
    PRIMARY KEY (role_id, permission_id),
    FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE,
    FOREIGN KEY (permission_id) REFERENCES permissions(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE staff (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    name            VARCHAR(120) NOT NULL,
    email           VARCHAR(190) NOT NULL UNIQUE,
    password_hash   VARCHAR(255) NOT NULL,
    role_id         INT NOT NULL,
    is_active       TINYINT(1) NOT NULL DEFAULT 1,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (role_id) REFERENCES roles(id)
) ENGINE=InnoDB;

-- ============================================================
-- 3. CATALOG: categories, products, attributes, variants, images
-- ============================================================

CREATE TABLE categories (
    id      INT AUTO_INCREMENT PRIMARY KEY,
    name    VARCHAR(100) NOT NULL UNIQUE,
    slug    VARCHAR(100) NOT NULL UNIQUE
) ENGINE=InnoDB;

CREATE TABLE products (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    category_id     INT NOT NULL,
    name            VARCHAR(200) NOT NULL,
    slug            VARCHAR(220) NOT NULL UNIQUE,
    description     TEXT,
    base_price      DECIMAL(10,2) NOT NULL,       -- fallback/display price; variants can override
    status          ENUM('active','inactive','draft') NOT NULL DEFAULT 'active',
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (category_id) REFERENCES categories(id),
    INDEX idx_products_category (category_id)
) ENGINE=InnoDB;

-- Attribute definitions (Phone Model, Color, Material, Style...)
CREATE TABLE attributes (
    id      INT AUTO_INCREMENT PRIMARY KEY,
    name    VARCHAR(80) NOT NULL UNIQUE
) ENGINE=InnoDB;

-- Which attributes are relevant to which category (e.g. Phone Model -> iPhone Covers)
CREATE TABLE category_attributes (
    category_id     INT NOT NULL,
    attribute_id    INT NOT NULL,
    PRIMARY KEY (category_id, attribute_id),
    FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE,
    FOREIGN KEY (attribute_id) REFERENCES attributes(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- A purchasable unit: "iPhone 14 Pro cover" or "Blue Leather Tote"
CREATE TABLE product_variants (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    product_id      INT NOT NULL,
    sku             VARCHAR(64) NOT NULL UNIQUE,
    price           DECIMAL(10,2) NOT NULL,
    compare_at_price DECIMAL(10,2) NULL,
    stock_quantity  INT NOT NULL DEFAULT 0,
    is_active       TINYINT(1) NOT NULL DEFAULT 1,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
    INDEX idx_variants_product (product_id)
) ENGINE=InnoDB;

-- Actual attribute values per variant (e.g. variant #5 -> Phone Model = "iPhone 15")
CREATE TABLE variant_attribute_values (
    variant_id      INT NOT NULL,
    attribute_id    INT NOT NULL,
    value           VARCHAR(150) NOT NULL,
    PRIMARY KEY (variant_id, attribute_id),
    FOREIGN KEY (variant_id) REFERENCES product_variants(id) ON DELETE CASCADE,
    FOREIGN KEY (attribute_id) REFERENCES attributes(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE product_images (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    product_id  INT NOT NULL,
    variant_id  INT NULL,            -- NULL = generic product image, else variant-specific
    url         VARCHAR(500) NOT NULL,
    sort_order  INT NOT NULL DEFAULT 0,
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
    FOREIGN KEY (variant_id) REFERENCES product_variants(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ============================================================
-- 4. CART & WISHLIST
-- ============================================================

CREATE TABLE carts (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    user_id     INT NOT NULL UNIQUE,     -- one active cart per user
    updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE cart_items (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    cart_id     INT NOT NULL,
    variant_id  INT NOT NULL,
    quantity    INT NOT NULL DEFAULT 1,
    added_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_cart_variant (cart_id, variant_id),
    FOREIGN KEY (cart_id) REFERENCES carts(id) ON DELETE CASCADE,
    FOREIGN KEY (variant_id) REFERENCES product_variants(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE wishlists (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    user_id     INT NOT NULL,
    product_id  INT NOT NULL,
    added_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_wishlist (user_id, product_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ============================================================
-- 5. COUPONS / PROMOTIONS
-- ============================================================

CREATE TABLE coupons (
    id                      INT AUTO_INCREMENT PRIMARY KEY,
    code                    VARCHAR(40) NOT NULL UNIQUE,
    description             VARCHAR(255),
    discount_type           ENUM('percentage','fixed') NOT NULL,
    discount_value          DECIMAL(10,2) NOT NULL,
    min_order_amount        DECIMAL(10,2) DEFAULT 0,
    usage_limit_total       INT NULL,          -- NULL = unlimited
    usage_limit_per_user    INT NULL DEFAULT 1,
    starts_at               DATETIME NULL,
    ends_at                 DATETIME NULL,
    is_active               TINYINT(1) NOT NULL DEFAULT 1,
    created_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE coupon_usages (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    coupon_id   INT NOT NULL,
    user_id     INT NOT NULL,
    order_id    INT NOT NULL,
    used_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    released_at DATETIME NULL,              -- order cancelled before payment confirmation: no longer counts
    UNIQUE KEY uq_coupon_usage_order (order_id),                -- one coupon per order
    INDEX idx_coupon_usage_active (coupon_id, user_id, released_at), -- limit counts under the coupon lock
    FOREIGN KEY (coupon_id) REFERENCES coupons(id),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (order_id) REFERENCES orders(id)
) ENGINE=InnoDB;

-- ============================================================
-- 6. ORDERS
-- ============================================================

CREATE TABLE orders (
    id                  INT AUTO_INCREMENT PRIMARY KEY,
    order_number        VARCHAR(30) NOT NULL UNIQUE,
    user_id             INT NULL,                -- NULL for a guest order (see guest_* columns)
    guest_name          VARCHAR(120) NULL,
    guest_phone         VARCHAR(20) NULL,
    guest_province      VARCHAR(100) NULL,
    guest_district      VARCHAR(100) NULL,
    guest_municipality  VARCHAR(150) NULL,
    guest_area          VARCHAR(255) NULL,
    guest_landmark      VARCHAR(255) NULL,
    guest_delivery_notes VARCHAR(500) NULL,
    guest_latitude      DECIMAL(10,7) NULL,
    guest_longitude     DECIMAL(10,7) NULL,
    status              ENUM('pending','processing','shipped','delivered','cancelled') NOT NULL DEFAULT 'pending',
    subtotal_amount     DECIMAL(10,2) NOT NULL,
    discount_amount     DECIMAL(10,2) NOT NULL DEFAULT 0,   -- coupon + loyalty points
    bundle_discount_amount DECIMAL(10,2) NOT NULL DEFAULT 0, -- Dashain campaign bundle saving, when active
    campaign_code       VARCHAR(40) NULL,        -- e.g. DASHAIN_2026; NULL outside any campaign
    campaign_name_snap  VARCHAR(150) NULL,       -- snapshot so old orders read correctly after the campaign changes
    tax_amount          DECIMAL(10,2) NOT NULL DEFAULT 0,
    shipping_amount     DECIMAL(10,2) NOT NULL DEFAULT 0,
    total_amount        DECIMAL(10,2) NOT NULL,
    coupon_id           INT NULL,
    shipping_address_id INT NULL,                -- NULL for a guest order (guest_* columns carry delivery info)
    billing_address_id  INT NULL,
    cancellation_reason VARCHAR(40) NULL,        -- customer | guest | staff | payment_timeout; NULL unless cancelled (or cancelled before this column)
    placed_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (coupon_id) REFERENCES coupons(id),
    FOREIGN KEY (shipping_address_id) REFERENCES addresses(id),
    FOREIGN KEY (billing_address_id) REFERENCES addresses(id),
    INDEX idx_orders_user (user_id),
    INDEX idx_orders_status (status)
) ENGINE=InnoDB;

-- Secure guest order access. Only the sha256 hash of the token is stored;
-- the raw token is returned once, at order creation, and never logged.
CREATE TABLE guest_order_tokens (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    order_id    INT NOT NULL UNIQUE,
    token_hash  VARCHAR(255) NOT NULL UNIQUE,
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE order_items (
    id                  INT AUTO_INCREMENT PRIMARY KEY,
    order_id            INT NOT NULL,
    variant_id          INT NOT NULL,
    product_name_snap   VARCHAR(200) NOT NULL,   -- snapshot in case product changes later
    sku_snap            VARCHAR(64) NOT NULL,
    unit_price          DECIMAL(10,2) NOT NULL,
    quantity            INT NOT NULL,
    line_total          DECIMAL(10,2) NOT NULL,
    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
    FOREIGN KEY (variant_id) REFERENCES product_variants(id)
) ENGINE=InnoDB;

CREATE TABLE order_status_history (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    order_id    INT NOT NULL,
    status      ENUM('pending','processing','shipped','delivered','cancelled') NOT NULL,
    changed_by_staff_id INT NULL,       -- NULL if system-generated
    note        VARCHAR(255),
    changed_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
    FOREIGN KEY (changed_by_staff_id) REFERENCES staff(id)
) ENGINE=InnoDB;

CREATE TABLE order_payment_confirmations (
    id INT AUTO_INCREMENT PRIMARY KEY,
    order_id INT NOT NULL UNIQUE,
    method ENUM('advance_qr','whatsapp_cod') NOT NULL,
    advance_amount DECIMAL(10,2) NOT NULL DEFAULT 100,
    status ENUM('pending','proof_uploaded','approved','rejected','cod_pending','cod_confirmed') NOT NULL DEFAULT 'pending',
    proof_filename VARCHAR(255) NULL,
    admin_note VARCHAR(500) NULL,
    reviewed_by_staff_id INT NULL,
    reviewed_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (order_id) REFERENCES orders(id),
    FOREIGN KEY (reviewed_by_staff_id) REFERENCES staff(id)
) ENGINE=InnoDB;

-- Free promotional line items with no catalogue SKU (e.g. the Dashain
-- suction holder). Snapshotted per order, never tied to real inventory.
CREATE TABLE order_promo_items (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    order_id    INT NOT NULL,
    sku_snap    VARCHAR(64) NOT NULL,
    name_snap   VARCHAR(200) NOT NULL,
    quantity    INT NOT NULL DEFAULT 1,
    unit_price  DECIMAL(10,2) NOT NULL DEFAULT 0,
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ============================================================
-- 7. REVIEWS
-- ============================================================

CREATE TABLE reviews (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    product_id      INT NOT NULL,
    user_id         INT NOT NULL,
    order_item_id   INT NULL,            -- link to verify a real purchase
    rating          TINYINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
    title           VARCHAR(150),
    body            TEXT,
    status          ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (order_item_id) REFERENCES order_items(id),
    INDEX idx_reviews_product_status (product_id, status)
) ENGINE=InnoDB;

-- ============================================================
-- 8. LOYALTY POINTS (ledger — users.loyalty_points is a cached total)
-- ============================================================

CREATE TABLE loyalty_transactions (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    user_id     INT NOT NULL,
    order_id    INT NULL,
    points      INT NOT NULL,             -- positive = earned, negative = redeemed
    type        ENUM('earn','redeem','expire','adjustment') NOT NULL,
    note        VARCHAR(255),
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (order_id) REFERENCES orders(id)
) ENGINE=InnoDB;

-- ============================================================
-- 9. STORE SETTINGS: shipping, tax, general config
-- ============================================================

CREATE TABLE shipping_rates (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    zone_name       VARCHAR(100) NOT NULL,     -- e.g. "Kathmandu Valley", "Outside Valley"
    method_name     VARCHAR(100) NOT NULL,     -- e.g. "Standard", "Express"
    cost            DECIMAL(10,2) NOT NULL,
    free_above_amount DECIMAL(10,2) NULL,      -- free shipping threshold, NULL = none
    is_active       TINYINT(1) NOT NULL DEFAULT 1
) ENGINE=InnoDB;

CREATE TABLE tax_rates (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    region_name     VARCHAR(100) NOT NULL,
    rate_percent    DECIMAL(5,2) NOT NULL,
    is_active       TINYINT(1) NOT NULL DEFAULT 1
) ENGINE=InnoDB;

CREATE TABLE store_settings (
    `key`       VARCHAR(80) PRIMARY KEY,   -- e.g. store_name, contact_email, currency
    `value`     VARCHAR(500) NOT NULL
) ENGINE=InnoDB;

-- ============================================================
-- 10. GUEST ORDER IDEMPOTENCY
-- ============================================================

-- One row per guest checkout submission (Idempotency-Key header). Only the
-- key's SHA-256 and a SHA-256 request fingerprint are stored, never the raw
-- key or the request body. replay_token_sealed is the guest access token
-- encrypted for 24h so a retry after a lost response can recover the order.
CREATE TABLE guest_order_idempotency (
    id                  INT AUTO_INCREMENT PRIMARY KEY,
    key_hash            CHAR(64) NOT NULL,
    request_fingerprint CHAR(64) NOT NULL,
    order_id            INT NULL,
    replay_token_sealed VARCHAR(255) NULL,
    created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at          DATETIME NOT NULL,
    UNIQUE KEY uq_guest_idem_key (key_hash),
    INDEX idx_guest_idem_expires (expires_at),
    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ============================================================
-- 11. INVENTORY RESERVATIONS
-- ============================================================

-- Unpaid orders reserve stock; product_variants.stock_quantity (physical) is
-- deducted only when payment is approved / COD confirmed. Available to sell =
-- stock_quantity - SUM(quantity) of active reservations whose expires_at is
-- NULL (proof awaiting staff review) or still in the future.
CREATE TABLE inventory_reservations (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    order_id    INT NOT NULL,
    variant_id  INT NOT NULL,
    quantity    INT NOT NULL,
    status      ENUM('active','committed','released','expired','restocked') NOT NULL DEFAULT 'active',
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    expires_at  DATETIME NULL,               -- NULL = payment proof awaiting staff review: no deadline
    UNIQUE KEY uq_reservation_order_variant (order_id, variant_id),
    INDEX idx_reservation_availability (variant_id, status, expires_at),
    INDEX idx_reservation_retention (status, updated_at),
    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
    FOREIGN KEY (variant_id) REFERENCES product_variants(id)
) ENGINE=InnoDB;

SET FOREIGN_KEY_CHECKS = 1;
