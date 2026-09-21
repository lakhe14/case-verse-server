'use strict';

const asyncHandler = require('../../utils/asyncHandler');
const settings = require('../../services/settings.service');

exports.getShipping = asyncHandler(async (req, res) => {
  res.json({ data: await settings.listShippingRates() });
});

exports.putShipping = asyncHandler(async (req, res) => {
  res.json({ data: await settings.replaceShippingRates(req.body.rates) });
});

exports.getGeneral = asyncHandler(async (req, res) => {
  res.json({ data: await settings.getGeneralSettings() });
});

exports.putGeneral = asyncHandler(async (req, res) => {
  res.json({ data: await settings.setGeneralSettings(req.body) });
});
