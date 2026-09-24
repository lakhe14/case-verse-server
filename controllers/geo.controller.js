'use strict';

const asyncHandler = require('../utils/asyncHandler');
const parcelmoover = require('../services/parcelmoover.service');
const localities = require('../services/geo/locality.service');
const geocoder = require('../services/geo/reverseGeocode.service');

// Suggestions are optional: without the live destination list the address
// and places are still returned, just without a courier suggestion.
async function destinationsOrEmpty() {
  try {
    return await parcelmoover.getDestinations();
  } catch (_) {
    return [];
  }
}

exports.reverse = asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ data: await geocoder.reverse(req.body, await destinationsOrEmpty()) });
});

exports.searchLocalities = asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ data: localities.search(req.body.q, await destinationsOrEmpty()) });
});
