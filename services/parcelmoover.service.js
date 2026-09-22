'use strict';

const ApiError = require('../utils/ApiError');

const REQUEST_TIMEOUT_MS = 10_000;
const DESTINATION_CACHE_TTL_MS = 5 * 60 * 1000;
const SERVICE_TYPES = new Set(['home_delivery', 'branch_delivery']);
let destinationCache = { expiresAt: 0, destinations: null };

function pricingError(message, code) {
  return new ApiError(503, message || 'Delivery charge is temporarily unavailable. Please try again.', code);
}

function getConfiguration() {
  // Read server-only variables lazily: a missing key does not prevent server
  // startup, and it is never copied into an API response or client config.
  const apiKey = process.env.PARCELMOOVER_API_KEY;
  const baseUrl = process.env.PARCELMOOVER_BASE_URL;
  const defaultWeightKg = Number(process.env.PARCELMOOVER_DEFAULT_WEIGHT_KG);
  if (!apiKey || !baseUrl || !Number.isFinite(defaultWeightKg) || defaultWeightKg <= 0) {
    throw pricingError('Delivery pricing is not configured. Please contact support.', 'parcelmoover_not_configured');
  }

  let endpoint;
  try {
    endpoint = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  } catch (_) {
    throw pricingError('Delivery pricing is not configured. Please contact support.', 'parcelmoover_not_configured');
  }
  if (!['http:', 'https:'].includes(endpoint.protocol)) {
    throw pricingError('Delivery pricing is not configured. Please contact support.', 'parcelmoover_not_configured');
  }
  return { apiKey, baseUrl: endpoint.toString(), defaultWeightKg };
}

async function request(path, query = {}) {
  const { apiKey, baseUrl } = getConfiguration();
  if (typeof fetch !== 'function') throw pricingError(undefined, 'parcelmoover_unavailable');

  // `path` is deliberately relative so `/api/v1` in PARCELMOOVER_BASE_URL is preserved.
  const url = new URL(path.replace(/^\/+/, ''), baseUrl);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) throw pricingError(undefined, 'parcelmoover_unavailable');
    try {
      return await response.json();
    } catch (_) {
      throw pricingError(undefined, 'parcelmoover_invalid_response');
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw pricingError(undefined, 'parcelmoover_unavailable');
  } finally {
    clearTimeout(timeout);
  }
}

function readArray(payload) {
  const data = payload?.data ?? payload;
  // ParcelMoover's rate card currently wraps destinations in data.rates.
  // Accept a top-level array too for the documented data-array variant.
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.rates)) return data.rates;
  return null;
}

function sanitizeDestinations(payload) {
  const rates = readArray(payload);
  if (!rates) throw pricingError(undefined, 'parcelmoover_invalid_response');
  const destinations = rates.map((rate) => {
    const id = String(rate?.destinationId || '').trim();
    const name = String(rate?.destinationName || '').trim();
    if (!id || !name) return null;
    return {
      id,
      name,
      zone: rate?.zone == null ? null : String(rate.zone),
      valley: rate?.valley == null ? null : String(rate.valley),
    };
  }).filter(Boolean);
  if (!destinations.length) throw pricingError(undefined, 'parcelmoover_invalid_response');
  return destinations;
}

async function getDestinations({ forceRefresh = false } = {}) {
  if (!forceRefresh && destinationCache.destinations && destinationCache.expiresAt > Date.now()) {
    return destinationCache.destinations;
  }
  const destinations = sanitizeDestinations(await request('rates'));
  destinationCache = { destinations, expiresAt: Date.now() + DESTINATION_CACHE_TTL_MS };
  return destinations;
}

async function ping() {
  const payload = await request('ping');
  if (payload?.success !== true) throw pricingError(undefined, 'parcelmoover_invalid_response');
  return true;
}

async function quote({ destinationId, weightKg, serviceType = 'home_delivery' }) {
  const normalizedDestinationId = String(destinationId || '').trim();
  const normalizedServiceType = String(serviceType || '').trim();
  const weight = Number(weightKg);
  if (!normalizedDestinationId || !Number.isFinite(weight) || weight <= 0 || !SERVICE_TYPES.has(normalizedServiceType)) {
    throw new ApiError(400, 'Select a valid delivery destination.', 'invalid_parcelmoover_destination');
  }

  const destinations = await getDestinations();
  const destination = destinations.find((item) => item.id === normalizedDestinationId);
  if (!destination) throw new ApiError(400, 'Select a valid delivery destination.', 'invalid_parcelmoover_destination');

  const payload = await request('rates/quote', {
    destinationLocationId: destination.id,
    weightKg: weight,
    serviceType: normalizedServiceType,
  });
  const data = payload?.data ?? payload;
  const totalPayable = Number(data?.totalPayable);
  if (!Number.isFinite(totalPayable) || totalPayable < 0) {
    throw pricingError(undefined, 'parcelmoover_invalid_response');
  }

  return {
    destination,
    service_type: normalizedServiceType,
    weight_kg: weight,
    amount: Number(totalPayable.toFixed(2)),
    base_charge: Number.isFinite(Number(data.baseCharge)) ? Number(Number(data.baseCharge).toFixed(2)) : null,
    weight_surcharge: Number.isFinite(Number(data.weightSurcharge)) ? Number(Number(data.weightSurcharge).toFixed(2)) : null,
    rate_type: typeof data.rateType === 'string' ? data.rateType : null,
    basis: typeof data.basis === 'string' ? data.basis : null,
    valley: typeof data.valley === 'string' ? data.valley : destination.valley,
  };
}

function clearDestinationCache() {
  destinationCache = { expiresAt: 0, destinations: null };
}

module.exports = { getConfiguration, getDestinations, ping, quote, clearDestinationCache };
