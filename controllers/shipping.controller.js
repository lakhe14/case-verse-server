'use strict';

const asyncHandler = require('../utils/asyncHandler');
const parcelmoover = require('../services/parcelmoover.service');
const localities = require('../services/geo/locality.service');

exports.destinations = asyncHandler(async (_req, res) => {
  // getDestinations already strips rate amounts and caches the provider result.
  // label/locality/district are parsed from the provider name for search and
  // display only; `id` stays the authoritative value sent back at checkout.
  const destinations = await parcelmoover.getDestinations();
  const described = localities.describeDestinations(destinations);
  res.json({ data: destinations.map((destination, index) => ({ ...destination, ...described[index] })) });
});
