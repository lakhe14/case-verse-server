'use strict';

const { QueryTypes } = require('sequelize');
const db = require('../models');

// Revenue counts only orders that were not cancelled.
const REVENUE_STATUSES = "('pending','processing','shipped','delivered')";

async function salesOverTime({ granularity = 'day', from, to } = {}) {
  const fmt = { day: '%Y-%m-%d', week: '%x-W%v', month: '%Y-%m' }[granularity] || '%Y-%m-%d';
  const where = [`status IN ${REVENUE_STATUSES}`];
  const repl = {};
  if (from) {
    where.push('placed_at >= :from');
    repl.from = from;
  }
  if (to) {
    where.push('placed_at <= :to');
    repl.to = to;
  }
  const rows = await db.sequelize.query(
    `SELECT DATE_FORMAT(placed_at, '${fmt}') AS bucket,
            COUNT(*) AS orders,
            SUM(total_amount) AS revenue,
            SUM(discount_amount + bundle_discount_amount) AS discounts
     FROM orders
     WHERE ${where.join(' AND ')}
     GROUP BY bucket
     ORDER BY bucket ASC`,
    { type: QueryTypes.SELECT, replacements: repl }
  );
  return rows.map((r) => ({
    bucket: r.bucket,
    orders: Number(r.orders),
    revenue: Number(r.revenue || 0),
    discounts: Number(r.discounts || 0),
  }));
}

async function topProducts({ limit = 4, from, to, periodDays = 30 } = {}) {
  const where = [`o.status IN ${REVENUE_STATUSES}`];
  const repl = { limit: Number(limit) };
  if (from) {
    where.push('o.placed_at >= :from');
    repl.from = from;
  } else if (periodDays) {
    where.push('o.placed_at >= :since');
    repl.since = new Date(Date.now() - periodDays * 86400000);
  }
  if (to) {
    where.push('o.placed_at <= :to');
    repl.to = to;
  }
  // Group by the actual product (via the ordered variant), not the name snapshot,
  // so renamed products still aggregate correctly and we can link to the PDP.
  const rows = await db.sequelize.query(
    `SELECT p.id, p.name, p.slug,
            SUM(oi.quantity) AS units_sold,
            SUM(oi.line_total) AS revenue
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     JOIN product_variants pv ON pv.id = oi.variant_id
     JOIN products p ON p.id = pv.product_id
     WHERE ${where.join(' AND ')}
     GROUP BY p.id, p.name, p.slug
     ORDER BY units_sold DESC, revenue DESC
     LIMIT :limit`,
    { type: QueryTypes.SELECT, replacements: repl }
  );
  return rows.map((r) => ({
    id: Number(r.id),
    name: r.name,
    slug: r.slug,
    units_sold: Number(r.units_sold),
    revenue: Number(r.revenue || 0),
  }));
}

/**
 * Daily revenue for the last 7 days ending today, always 7 entries, zero-filled
 * for any day with no (non-cancelled) orders. Labelled by weekday (Mon, Tue…).
 */
async function revenueLast7Days() {
  const rows = await db.sequelize.query(
    `SELECT DATE_FORMAT(placed_at, '%Y-%m-%d') AS d,
            COALESCE(SUM(total_amount), 0) AS revenue
     FROM orders
     WHERE status IN ${REVENUE_STATUSES}
       AND placed_at >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)
     GROUP BY d`,
    { type: QueryTypes.SELECT }
  );
  const byDay = new Map(rows.map((r) => [r.d, Number(r.revenue)]));

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const series = [];
  for (let i = 6; i >= 0; i -= 1) {
    const dt = new Date(today);
    dt.setDate(dt.getDate() - i);
    const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(
      dt.getDate()
    ).padStart(2, '0')}`;
    series.push({
      date: key,
      label: dt.toLocaleDateString('en-US', { weekday: 'short' }),
      revenue: byDay.get(key) || 0,
    });
  }
  return series;
}

/** Latest orders for the dashboard table, newest first, with a summed item count. */
async function recentOrders({ limit = 8 } = {}) {
  const rows = await db.sequelize.query(
    `SELECT o.id, o.order_number, o.status, o.total_amount, o.placed_at,
            u.name AS customer_name,
            (SELECT COALESCE(SUM(oi.quantity), 0) FROM order_items oi WHERE oi.order_id = o.id) AS item_count
     FROM orders o
     LEFT JOIN users u ON u.id = o.user_id
     ORDER BY o.placed_at DESC
     LIMIT :limit`,
    { type: QueryTypes.SELECT, replacements: { limit: Number(limit) } }
  );
  return rows.map((r) => ({
    id: Number(r.id),
    order_number: r.order_number,
    customer_name: r.customer_name || 'Guest',
    item_count: Number(r.item_count),
    total_amount: Number(r.total_amount),
    status: r.status,
    placed_at: r.placed_at,
  }));
}

async function overview() {
  const [totals] = await db.sequelize.query(
    `SELECT
        (SELECT COUNT(*) FROM orders WHERE status IN ${REVENUE_STATUSES}) AS total_orders,
        (SELECT COALESCE(SUM(total_amount),0) FROM orders WHERE status IN ${REVENUE_STATUSES}) AS total_revenue,
        (SELECT COUNT(*) FROM users) AS total_customers,
        (SELECT COUNT(*) FROM orders WHERE status = 'pending') AS pending_orders,
        (SELECT COUNT(*) FROM reviews WHERE status = 'pending') AS pending_reviews`,
    { type: QueryTypes.SELECT }
  );
  return {
    total_orders: Number(totals.total_orders),
    total_revenue: Number(totals.total_revenue || 0),
    total_customers: Number(totals.total_customers),
    pending_orders: Number(totals.pending_orders),
    pending_reviews: Number(totals.pending_reviews),
  };
}

const pctChange = (cur, prev) =>
  prev > 0 ? Math.round(((cur - prev) / prev) * 100) : null;

/**
 * Everything the admin Dashboard needs in one call:
 *  - period-scoped revenue / order count / new-customer count, each with the
 *    % change vs. the immediately-preceding period of equal length
 *  - current pending-order count (not period-scoped)
 *  - the last-7-days zero-filled revenue series
 *  - top products by units sold in the period
 *  - the most recent orders
 */
async function dashboard({ periodDays = 30 } = {}) {
  const now = Date.now();
  const curFrom = new Date(now - periodDays * 86400000);
  const prevFrom = new Date(now - 2 * periodDays * 86400000);

  const [m] = await db.sequelize.query(
    `SELECT
        (SELECT COALESCE(SUM(total_amount),0) FROM orders
           WHERE status IN ${REVENUE_STATUSES} AND placed_at >= :curFrom) AS rev_cur,
        (SELECT COALESCE(SUM(total_amount),0) FROM orders
           WHERE status IN ${REVENUE_STATUSES} AND placed_at >= :prevFrom AND placed_at < :curFrom) AS rev_prev,
        (SELECT COUNT(*) FROM orders
           WHERE status IN ${REVENUE_STATUSES} AND placed_at >= :curFrom) AS ord_cur,
        (SELECT COUNT(*) FROM orders
           WHERE status IN ${REVENUE_STATUSES} AND placed_at >= :prevFrom AND placed_at < :curFrom) AS ord_prev,
        (SELECT COUNT(*) FROM users WHERE created_at >= :curFrom) AS cust_cur,
        (SELECT COUNT(*) FROM users WHERE created_at >= :prevFrom AND created_at < :curFrom) AS cust_prev,
        (SELECT COUNT(*) FROM orders WHERE status = 'pending') AS pending_orders,
        (SELECT COUNT(*) FROM orders) AS orders_all_time,
        (SELECT COUNT(*) FROM reviews WHERE status = 'pending') AS pending_reviews`,
    { type: QueryTypes.SELECT, replacements: { curFrom, prevFrom } }
  );

  const metric = (cur, prev) => ({
    value: Number(cur),
    previous: Number(prev),
    change_pct: pctChange(Number(cur), Number(prev)),
  });

  const [revenueWeek, topProductsList, recent] = await Promise.all([
    revenueLast7Days(),
    topProducts({ limit: 4, periodDays }),
    recentOrders({ limit: 8 }),
  ]);

  return {
    period_days: periodDays,
    has_orders: Number(m.orders_all_time) > 0,
    stats: {
      revenue: metric(m.rev_cur, m.rev_prev),
      orders: metric(m.ord_cur, m.ord_prev),
      new_customers: metric(m.cust_cur, m.cust_prev),
      pending_orders: Number(m.pending_orders),
    },
    pending_reviews: Number(m.pending_reviews),
    revenue_week: revenueWeek,
    top_products: topProductsList,
    recent_orders: recent,
  };
}

/* ------------------------------ Customers ------------------------------ */

async function listCustomers({ page = 1, limit = 20, q } = {}) {
  const where = {};
  if (q) {
    where[db.Sequelize.Op.or] = [
      { name: { [db.Sequelize.Op.like]: `%${q}%` } },
      { email: { [db.Sequelize.Op.like]: `%${q}%` } },
    ];
  }
  const { rows, count } = await db.User.findAndCountAll({
    where,
    attributes: ['id', 'name', 'email', 'phone', 'loyalty_points', 'is_active', 'created_at'],
    order: [['created_at', 'DESC']],
    limit,
    offset: (page - 1) * limit,
  });
  return { data: rows, pagination: { page, limit, total: count, pages: Math.ceil(count / limit) } };
}

async function customerDetail(userId) {
  const user = await db.User.findByPk(userId, {
    attributes: ['id', 'name', 'email', 'phone', 'loyalty_points', 'is_active', 'created_at'],
    include: [
      { model: db.Order, as: 'orders', include: [{ model: db.OrderItem, as: 'items' }] },
      { model: db.LoyaltyTransaction, as: 'loyaltyTransactions' },
      { model: db.Address, as: 'addresses' },
    ],
    order: [[{ model: db.Order, as: 'orders' }, 'placed_at', 'DESC']],
  });
  if (!user) return null;
  const plain = user.get({ plain: true });
  plain.lifetime_value = (plain.orders || [])
    .filter((o) => o.status !== 'cancelled')
    .reduce((s, o) => s + Number(o.total_amount), 0);
  return plain;
}

module.exports = {
  salesOverTime,
  topProducts,
  revenueLast7Days,
  recentOrders,
  overview,
  dashboard,
  listCustomers,
  customerDetail,
};
