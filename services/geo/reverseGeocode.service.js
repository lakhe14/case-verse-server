'use strict';

/**
 * Reverse geocoding for checkout "Use my location".
 *
 * The browser never talks to the geocoder: it posts the position to
 * POST /api/geo/reverse, and this service asks a Nominatim-compatible API
 * (public OpenStreetMap Nominatim by default, see config geocoder.*).
 *
 * Privacy and usage-policy rules:
 * - The position is rounded to 3 decimals (about 110 m) before it is sent
 *   upstream, cached, or used for a suggestion; the precise value is dropped.
 * - Positions are never logged or stored. The cache lives in process memory,
 *   keyed by the rounded position, and expires.
 * - At most one upstream request per second across this process; callers
 *   that would wait too long get a "busy" error instead of queuing forever.
 * - Identifying User-Agent and Referer headers, as the Nominatim policy asks.
 * - Only used after an explicit tap; never for search-as-you-type.
 */

const ApiError = require('../../utils/ApiError');
const env = require('../../config/env');
const localities = require('./locality.service');

const REQUEST_TIMEOUT_MS = 8000;
const MIN_INTERVAL_MS = 1100;
const MAX_QUEUE_WAIT_MS = 5000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX = 500;
const PRECISION = 3;

const cache = new Map();
let nextSlot = 0;

// Nepal's ISO 3166-2 province codes; OSM's own province names vary in spelling.
const PROVINCE_BY_ISO = {
  'NP-P1': 'Koshi Province', 'NP-P2': 'Madhesh Province', 'NP-P3': 'Bagmati Province', 'NP-P4': 'Gandaki Province',
  'NP-P5': 'Lumbini Province', 'NP-P6': 'Karnali Province', 'NP-P7': 'Sudurpaschim Province',
};

function unavailable(code = 'geocoder_unavailable') {
  return new ApiError(503, 'We could not look up an address for your location. Please enter it manually.', code);
}

function roundCoordinate(value) {
  return Number(Number(value).toFixed(PRECISION));
}

/** Waits for this caller's upstream slot, keeping requests at least MIN_INTERVAL_MS apart. */
async function acquireSlot() {
  const now = Date.now();
  const slot = Math.max(now, nextSlot);
  if (slot - now > MAX_QUEUE_WAIT_MS) throw unavailable('geocoder_busy');
  nextSlot = slot + MIN_INTERVAL_MS;
  if (slot > now) await new Promise((resolve) => setTimeout(resolve, slot - now));
}

function userAgent() {
  const contact = env.geocoder.contact || env.geocoder.referer;
  return `CaseVerse/1.0 (checkout address lookup; ${contact})`;
}

async function fetchUpstream(lat, lon) {
  if (env.geocoder.stub) return require('./reverseGeocode.e2eStub').respond(lat, lon);
  if (typeof fetch !== 'function') throw unavailable();
  let url;
  try {
    const base = env.geocoder.baseUrl.endsWith('/') ? env.geocoder.baseUrl : `${env.geocoder.baseUrl}/`;
    url = new URL('reverse', base);
  } catch (_) {
    throw unavailable('geocoder_not_configured');
  }
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('lat', String(lat));
  url.searchParams.set('lon', String(lon));
  url.searchParams.set('zoom', '18');
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('accept-language', 'en');
  if (env.geocoder.apiKey) url.searchParams.set('key', env.geocoder.apiKey);

  await acquireSlot();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': userAgent(), Referer: env.geocoder.referer, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (response.status === 429) throw unavailable('geocoder_busy');
    if (!response.ok) throw unavailable();
    return await response.json();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw unavailable();
  } finally {
    clearTimeout(timeout);
  }
}

const first = (...values) => values.find((value) => typeof value === 'string' && value.trim())?.trim() || null;

/** Reads the parts we use from a Nominatim address object; tolerates missing fields. */
function readAddress(payload) {
  const address = payload?.address;
  if (!address || typeof address !== 'object') return null;
  if (address.country_code && String(address.country_code).toLowerCase() !== 'np') return { outside_nepal: true };
  const municipality = first(address.city, address.municipality, address.town, address.village);
  const locality = first(address.neighbourhood, address.suburb, address.quarter, address.hamlet, address.residential, address.city_block);
  // "Kathmandu-04" style city_district values carry the ward number.
  const wardMatch = /-(\d{1,2})$/.exec(String(address.city_district || ''));
  return {
    province: PROVINCE_BY_ISO[address['ISO3166-2-lvl4']] || first(address.state),
    district: first(address.county, address.state_district)?.replace(/\s+district$/i, '') || null,
    municipality,
    locality: locality && locality !== municipality ? locality : null,
    street: first(address.road, address.pedestrian, address.footway),
    ward: wardMatch ? Number(wardMatch[1]) : null,
  };
}

async function reverse({ latitude, longitude }, destinations) {
  const lat = roundCoordinate(latitude);
  const lon = roundCoordinate(longitude);
  const key = `${lat},${lon}`;

  let address;
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) {
    address = hit.address;
  } else {
    address = readAddress(await fetchUpstream(lat, lon));
    if (address) {
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
      cache.set(key, { address, expiresAt: Date.now() + CACHE_TTL_MS });
    }
  }
  if (!address) throw new ApiError(404, 'We could not find an address for your location. Please enter it manually.', 'location_not_found');
  if (address.outside_nepal) throw new ApiError(422, 'Your location appears to be outside Nepal. Please enter your delivery address manually.', 'location_outside_nepal');

  const resolved = localities.resolveAddress({ ...address, lat, lon }, destinations);
  return {
    province: resolved.province || address.province,
    district: resolved.district,
    municipality: resolved.municipality,
    ward: address.ward,
    locality: resolved.locality,
    street: resolved.street,
    suggested_destination: resolved.suggested_destination,
    source: 'openstreetmap',
    attribution: '© OpenStreetMap contributors',
  };
}

function clearCache() {
  cache.clear();
  nextSlot = 0;
}

module.exports = { reverse, readAddress, roundCoordinate, clearCache };
