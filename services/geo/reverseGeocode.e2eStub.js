'use strict';

/**
 * TEST-ONLY reverse-geocoder responses for the isolated E2E environment.
 * reverseGeocode.service.js loads this module only when env.geocoder.stub is
 * true, which config/env.js allows solely under NODE_ENV=e2e. It returns the
 * Nominatim payload shape so the real parsing and mapping code runs.
 */

const HADIGAUN = {
  address: {
    road: 'Hadigaun Marg', neighbourhood: 'Hadigaun', city_district: 'Kathmandu-05', city: 'Kathmandu Metropolitan City',
    county: 'Kathmandu', state: 'Bagamati Province', 'ISO3166-2-lvl4': 'NP-P3', country: 'Nepal', country_code: 'np',
  },
};

async function respond() {
  return HADIGAUN;
}

module.exports = { respond, HADIGAUN };
