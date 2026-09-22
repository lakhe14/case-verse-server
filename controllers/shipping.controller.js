'use strict';

const asyncHandler = require('../utils/asyncHandler');
const parcelmoover = require('../services/parcelmoover.service');

exports.destinations = asyncHandler(async (_req, res) => {
  // getDestinations already strips rate amounts and caches the provider result.
  res.json({ data: await parcelmoover.getDestinations() });
});
