'use strict';

/**
 * Retention of terminal inventory_reservations rows (pruneTerminalReservations).
 * DB-backed against caseverse_e2e. Rows are aged by back-dating updated_at.
 */

const inventory = require('../../services/inventory.service');
const { api, db, login, auth, SKU, placeGuestOrder } = require('./helpers');

afterAll(() => db.sequelize.close());

const sku = SKU.pinkFloral15Pro;
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n) => new Date(Date.now() - n * DAY);

async function guestOrder(label) {
  const placed = await placeGuestOrder([{ sku, quantity: 1 }], { label });
  expect(placed.status).toBe(201);
  return { id: placed.body.data.id, token: placed.body.guest_token };
}

async function approve(orderId) {
  const confirmation = await db.OrderPaymentConfirmation.findOne({ where: { order_id: orderId } });
  const res = await api().post(`/api/admin/payment-confirmations/${confirmation.id}/approve`).set(auth(await login('staff'))).send({});
  expect(res.status).toBe(200);
}

/** Back-dates the order's reservation rows without touching their status. */
async function age(orderId, days) {
  // Sequelize always manages updated_at itself, so the test sets it directly.
  // Relative to the DB clock: raw replacements would format the Date in local time.
  await db.sequelize.query('UPDATE inventory_reservations SET updated_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY) WHERE order_id = ?', { replacements: [days, orderId] });
  const row = await db.InventoryReservation.findOne({ where: { order_id: orderId } });
  expect(Date.now() - row.updated_at.getTime()).toBeGreaterThan((days - 1) * DAY);
  return row;
}

const rowsOf = (orderId) => db.InventoryReservation.count({ where: { order_id: orderId } });

/** One order per scenario, each in the state named by its key. */
async function buildScenarios() {
  const s = {};

  s.releasedOld = await guestOrder('ret-released-old');
  await api().post(`/api/guest-checkout/orders/${s.releasedOld.token}/cancel`);
  await age(s.releasedOld.id, 91);

  s.releasedRecent = await guestOrder('ret-released-recent');
  await api().post(`/api/guest-checkout/orders/${s.releasedRecent.token}/cancel`);
  await age(s.releasedRecent.id, 30);

  // Expired rows of a cancelled order (state left by a lapse recorded before cancellation).
  s.expiredOld = await guestOrder('ret-expired-old');
  await api().post(`/api/guest-checkout/orders/${s.expiredOld.token}/cancel`);
  await db.InventoryReservation.update({ status: 'expired' }, { where: { order_id: s.expiredOld.id } });
  await age(s.expiredOld.id, 91);

  // Expired hold on a still-pending order: the order can still be confirmed or
  // cancelled, so its row must stay whatever its age.
  s.expiredPendingOld = await guestOrder('ret-expired-pending');
  await db.InventoryReservation.update({ status: 'expired', expires_at: daysAgo(200) }, { where: { order_id: s.expiredPendingOld.id } });
  await age(s.expiredPendingOld.id, 200);

  s.restockedOld = await guestOrder('ret-restocked-old');
  await api().post(`/api/guest-checkout/orders/${s.restockedOld.token}/payment-method/cod`);
  await approve(s.restockedOld.id);
  expect((await api().put(`/api/admin/orders/${s.restockedOld.id}/status`).set(auth(await login('staff'))).send({ status: 'cancelled' })).status).toBe(200);
  expect((await db.InventoryReservation.findOne({ where: { order_id: s.restockedOld.id } })).status).toBe('restocked');
  await age(s.restockedOld.id, 181);

  // Restocked, past the released/expired window but inside its own longer one.
  s.restockedMid = await guestOrder('ret-restocked-mid');
  await api().post(`/api/guest-checkout/orders/${s.restockedMid.token}/payment-method/cod`);
  await approve(s.restockedMid.id);
  await api().put(`/api/admin/orders/${s.restockedMid.id}/status`).set(auth(await login('staff'))).send({ status: 'cancelled' });
  await age(s.restockedMid.id, 120);

  s.activeOld = await guestOrder('ret-active-old');
  await age(s.activeOld.id, 400);

  s.committedOld = await guestOrder('ret-committed-old');
  await api().post(`/api/guest-checkout/orders/${s.committedOld.token}/payment-method/cod`);
  await approve(s.committedOld.id);
  await age(s.committedOld.id, 400);

  return s;
}

const ELIGIBLE = ['releasedOld', 'expiredOld', 'restockedOld'];
const KEPT = ['releasedRecent', 'expiredPendingOld', 'restockedMid', 'activeOld', 'committedOld'];

describe('pruneTerminalReservations', () => {
  let s;
  beforeAll(async () => {
    s = await buildScenarios();
  });

  it('defaults to 90 days for released/expired and 180 for restocked', () => {
    expect(inventory.retentionDays()).toEqual({ released: 90, expired: 90, restocked: 180 });
  });

  it('dry run counts the eligible rows and deletes nothing', async () => {
    const before = await db.InventoryReservation.count();
    const result = await inventory.pruneTerminalReservations();
    expect(result.dry_run).toBe(true);
    expect(result.deleted).toBe(0);
    expect(result.eligible).toBeGreaterThanOrEqual(ELIGIBLE.length);
    expect(await db.InventoryReservation.count()).toBe(before);
    for (const key of [...ELIGIBLE, ...KEPT]) expect(await rowsOf(s[key].id)).toBe(1);
  });

  it('execute respects the batch size and removes only eligible terminal rows', async () => {
    const { eligible } = await inventory.pruneTerminalReservations();
    const first = await inventory.pruneTerminalReservations({ execute: true, batchSize: 2, maxBatches: 1 });
    expect(first).toMatchObject({ dry_run: false, batches: 1, deleted: Math.min(2, eligible) });

    const rest = await inventory.pruneTerminalReservations({ execute: true, batchSize: 2 });
    expect(rest.deleted).toBe(eligible - first.deleted);
    expect(rest.batches).toBe(Math.ceil(rest.deleted / 2));

    for (const key of ELIGIBLE) expect({ key, rows: await rowsOf(s[key].id) }).toEqual({ key, rows: 0 });
    for (const key of KEPT) expect({ key, rows: await rowsOf(s[key].id) }).toEqual({ key, rows: 1 });
    expect((await inventory.pruneTerminalReservations()).eligible).toBe(0);
  });

  it('never prunes active or committed rows, however old', async () => {
    const statuses = (await db.InventoryReservation.findAll({ where: { order_id: [s.activeOld.id, s.committedOld.id] }, order: [['order_id', 'ASC']] })).map((r) => r.status);
    expect(statuses).toEqual(['active', 'committed']);
  });

  it('the retention window is configurable', async () => {
    process.env.INVENTORY_RESERVATION_RETENTION_DAYS = '10';
    try {
      expect(inventory.retentionDays().released).toBe(10);
      // releasedRecent (30 days) now qualifies; nothing else does.
      const result = await inventory.pruneTerminalReservations();
      expect(result.eligible).toBe(1);
    } finally {
      delete process.env.INVENTORY_RESERVATION_RETENTION_DAYS;
    }
  });
});
