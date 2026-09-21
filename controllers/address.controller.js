'use strict';

const asyncHandler = require('../utils/asyncHandler');
const db = require('../models');
const ApiError = require('../utils/ApiError');

async function findOwnedAddress(userId, addressId) {
  const address = await db.Address.findOne({ where: { id: addressId, user_id: userId } });
  if (!address) throw ApiError.notFound('Address not found', 'address_not_found');
  return address;
}

// When an address is marked default, clear the flag on the user's other addresses.
async function clearOtherDefaults(userId, exceptId, transaction) {
  await db.Address.update(
    { is_default: false },
    { where: { user_id: userId, id: { [db.Sequelize.Op.ne]: exceptId || 0 } }, transaction }
  );
}

exports.list = asyncHandler(async (req, res) => {
  const addresses = await db.Address.findAll({
    where: { user_id: req.auth.id },
    order: [
      ['is_default', 'DESC'],
      ['id', 'DESC'],
    ],
  });
  res.json({ data: addresses });
});

exports.get = asyncHandler(async (req, res) => {
  const address = await findOwnedAddress(req.auth.id, req.params.id);
  res.json({ data: address });
});

exports.create = asyncHandler(async (req, res) => {
  const userId = req.auth.id;
  const count = await db.Address.count({ where: { user_id: userId } });
  const makeDefault = req.body.is_default || count === 0;

  const address = await db.sequelize.transaction(async (t) => {
    const created = await db.Address.create(
      { ...req.body, user_id: userId, is_default: makeDefault },
      { transaction: t }
    );
    if (makeDefault) await clearOtherDefaults(userId, created.id, t);
    return created;
  });

  res.status(201).json({ data: address });
});

exports.update = asyncHandler(async (req, res) => {
  const userId = req.auth.id;
  const address = await findOwnedAddress(userId, req.params.id);

  await db.sequelize.transaction(async (t) => {
    await address.update(req.body, { transaction: t });
    if (req.body.is_default === true) await clearOtherDefaults(userId, address.id, t);
  });

  res.json({ data: address });
});

exports.remove = asyncHandler(async (req, res) => {
  const userId = req.auth.id;
  const address = await findOwnedAddress(userId, req.params.id);
  const wasDefault = address.is_default;
  await address.destroy();

  // Promote another address to default if we just removed the default one.
  if (wasDefault) {
    const next = await db.Address.findOne({
      where: { user_id: userId },
      order: [['id', 'DESC']],
    });
    if (next) {
      next.is_default = true;
      await next.save();
    }
  }

  res.status(204).end();
});

exports.setDefault = asyncHandler(async (req, res) => {
  const userId = req.auth.id;
  const address = await findOwnedAddress(userId, req.params.id);
  await db.sequelize.transaction(async (t) => {
    address.is_default = true;
    await address.save({ transaction: t });
    await clearOtherDefaults(userId, address.id, t);
  });
  res.json({ data: address });
});
