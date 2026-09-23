'use strict';

/**
 * TEST-ONLY ParcelMoover responses for the isolated E2E environment.
 * parcelmoover.service.js loads this module only when env.parcelmooverStub is
 * true, which config/env.js allows solely under NODE_ENV=e2e. It returns the
 * same payload shapes as the provider so the real parsing/validation code runs.
 */

const DESTINATIONS = [
  { destinationId: 'e2e-kathmandu', destinationName: 'E2E Kathmandu', zone: 'Inside valley', valley: 'inside', baseCharge: 100 },
  { destinationId: 'e2e-pokhara', destinationName: 'E2E Pokhara', zone: 'Outside valley', valley: 'outside', baseCharge: 150 },
];

function configuration() {
  return { apiKey: 'e2e-stub', baseUrl: 'http://parcelmoover.e2e-stub.invalid/', defaultWeightKg: 0.25 };
}

async function respond(path, query = {}) {
  if (path === 'rates') {
    return { data: { rates: DESTINATIONS.map(({ baseCharge, ...rate }) => rate) } };
  }
  if (path === 'ping') return { success: true };
  if (path === 'rates/quote') {
    const destination = DESTINATIONS.find((item) => item.destinationId === query.destinationLocationId);
    if (!destination) return { data: {} };
    // Deterministic: base charge plus NPR 10 for every started 0.5 kg above 0.5 kg.
    const extraSteps = Math.max(0, Math.ceil((Number(query.weightKg) - 0.5) / 0.5));
    const weightSurcharge = extraSteps * 10;
    return {
      data: {
        baseCharge: destination.baseCharge,
        weightSurcharge,
        totalPayable: destination.baseCharge + weightSurcharge,
        rateType: 'e2e-stub',
        basis: 'E2E deterministic rate',
        valley: destination.valley,
      },
    };
  }
  return {};
}

module.exports = { DESTINATIONS, configuration, respond };
