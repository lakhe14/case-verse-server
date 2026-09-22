'use strict';

const service = require('../services/parcelmoover.service');

const destinationPayload = { data: { rates: [{ destinationId: 'POKHARA', destinationName: 'Pokhara', zone: 'outside', valley: 'outside', homeRate: 150, branchRate: 100 }] } };

describe('ParcelMoover service', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.PARCELMOOVER_API_KEY = 'test-key';
    process.env.PARCELMOOVER_BASE_URL = 'https://portal.parcelmoover.com/api/v1';
    process.env.PARCELMOOVER_DEFAULT_WEIGHT_KG = '0.5';
    service.clearDestinationCache();
  });
  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.PARCELMOOVER_API_KEY;
    delete process.env.PARCELMOOVER_BASE_URL;
    delete process.env.PARCELMOOVER_DEFAULT_WEIGHT_KG;
  });

  it('uses the documented relative API paths and quote parameters', async () => {
    const calls = [];
    global.fetch = jest.fn(async (url, options) => {
      calls.push({ url: String(url), options });
      return { ok: true, json: async () => String(url).includes('/rates/quote')
        ? { baseCharge: 150, weightSurcharge: 7.5, totalPayable: 157.5, rateType: 'flat', basis: 'Flat home rate (outside valley)', valley: 'outside' }
        : destinationPayload };
    });
    const quote = await service.quote({ destinationId: 'POKHARA', weightKg: 0.5, serviceType: 'home_delivery' });
    expect(calls[0].url).toBe('https://portal.parcelmoover.com/api/v1/rates');
    expect(calls[1].url).toContain('/api/v1/rates/quote?destinationLocationId=POKHARA&weightKg=0.5&serviceType=home_delivery');
    expect(calls.every((call) => call.options.headers.Authorization === 'Bearer test-key')).toBe(true);
    expect(quote).toMatchObject({ amount: 157.5, base_charge: 150, weight_surcharge: 7.5, rate_type: 'flat' });
  });

  it('rejects invalid ParcelMoover quote data without a fallback amount', async () => {
    global.fetch = jest.fn(async (url) => ({ ok: true, json: async () => String(url).includes('/rates/quote') ? { totalPayable: 'not-money' } : destinationPayload }));
    await expect(service.quote({ destinationId: 'POKHARA', weightKg: 0.5 })).rejects.toMatchObject({ code: 'parcelmoover_invalid_response', status: 503 });
  });

  it('returns a controlled error when the carrier is unavailable', async () => {
    global.fetch = jest.fn(async () => { throw new Error('offline'); });
    await expect(service.getDestinations()).rejects.toMatchObject({ code: 'parcelmoover_unavailable', status: 503 });
  });

  it('returns a controlled configuration error when the secret is missing', async () => {
    delete process.env.PARCELMOOVER_API_KEY;
    await expect(service.getDestinations()).rejects.toMatchObject({ code: 'parcelmoover_not_configured', status: 503 });
  });
});
