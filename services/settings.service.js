'use strict';

const db = require('../models');

/** Key-value store settings as a plain object. */
async function getGeneralSettings() {
  const rows = await db.StoreSetting.findAll();
  return rows.reduce((acc, row) => {
    acc[row.key] = row.value;
    return acc;
  }, {});
}

async function setGeneralSettings(pairs) {
  const entries = Object.entries(pairs);
  await db.sequelize.transaction(async (t) => {
    for (const [key, value] of entries) {
      await db.StoreSetting.upsert({ key, value: String(value) }, { transaction: t });
    }
  });
  return getGeneralSettings();
}

/**
 * Resolve a shipping cost for an order.
 * Strategy: match the active rate whose zone_name equals the address city or
 * state, else fall back to the first active rate. free_above_amount waives it.
 */
async function resolveShipping({ address, subtotal }) {
  const rates = await db.ShippingRate.findAll({ where: { is_active: true }, order: [['id', 'ASC']] });
  if (rates.length === 0) return { cost: 0, rate: null };

  const target = [address?.city, address?.state, address?.country]
    .filter(Boolean)
    .map((s) => s.toLowerCase());
  const match =
    rates.find((r) => target.includes(r.zone_name.toLowerCase())) || rates[0];

  let cost = Number(match.cost);
  if (match.free_above_amount != null && subtotal >= Number(match.free_above_amount)) {
    cost = 0;
  }
  return { cost: Number(cost.toFixed(2)), rate: match };
}

async function listShippingRates() {
  return db.ShippingRate.findAll({ order: [['id', 'ASC']] });
}

/** Upsert the supplied rows and delete any existing rows not in the payload. */
async function replaceShippingRates(rows) {
  return db.sequelize.transaction(async (t) => {
    const keepIds = [];
    for (const row of rows) {
      if (row.id) {
        await db.ShippingRate.update(row, { where: { id: row.id }, transaction: t });
        keepIds.push(row.id);
      } else {
        const created = await db.ShippingRate.create(row, { transaction: t });
        keepIds.push(created.id);
      }
    }
    await db.ShippingRate.destroy({
      where: { id: { [db.Sequelize.Op.notIn]: keepIds.length ? keepIds : [0] } },
      transaction: t,
    });
    return db.ShippingRate.findAll({ order: [['id', 'ASC']], transaction: t });
  });
}

module.exports = {
  getGeneralSettings,
  setGeneralSettings,
  resolveShipping,
  listShippingRates,
  replaceShippingRates,
};
