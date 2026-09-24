'use strict';

const localities = require('../services/geo/locality.service');
const geocoder = require('../services/geo/reverseGeocode.service');
const env = require('../config/env');
const { guestPlaceOrderSchema } = require('../validators/order.validators');
const { canonicalGuestRequest } = require('../services/guestIdempotency');

// Real ParcelMoover destination names (public rate card, September 2026) with
// test-only ids, so mapping is exercised against the provider's real naming.
const destinations = require('./fixtures/parcelmoover-destination-names.json')
  .map(([name, zone, valley], index) => ({ id: `pm-${index}`, name, zone, valley }));
const destinationIds = new Set(destinations.map((destination) => destination.id));
const byName = (name) => destinations.find((destination) => destination.name === name);

const first = (query) => localities.search(query, destinations)[0];

describe('locality search: familiar places map to real ParcelMoover destinations', () => {
  it('Hadigaun is a Kathmandu locality suggesting the inside-valley destination', () => {
    const result = first('Hadigaun');
    expect(result).toMatchObject({ kind: 'locality', name: 'Hadigaun', municipality: 'Kathmandu Metropolitan City', district: 'Kathmandu', province: 'Bagmati Province' });
    expect(result.suggested_destination).toMatchObject({ id: byName('INSIDE VALLEY - KTM').id, match: 'municipality' });
  });

  it('Basantapur lists the Kathmandu locality first and still shows the Terhathum destination', () => {
    const results = localities.search('Basantapur', destinations);
    expect(results[0]).toMatchObject({ name: 'Basantapur', district: 'Kathmandu' });
    expect(results[0].suggested_destination.id).toBe(byName('INSIDE VALLEY - KTM').id);
    const terhathum = results.find((result) => result.district === 'Terhathum' && result.kind === 'locality');
    expect(terhathum.suggested_destination).toMatchObject({ id: byName('BASANTAPUR - TERHATHUM').id, match: 'exact' });
    expect(results.some((result) => result.kind === 'destination' && result.suggested_destination.id === byName('BASANTAPUR - TERHATHUM').id)).toBe(true);
  });

  it('Sukute resolves to Sindhupalchok and suggests a real destination in that district', () => {
    const result = first('Sukute');
    expect(result).toMatchObject({ name: 'Sukute', district: 'Sindhupalchok', province: 'Bagmati Province' });
    expect(result.suggested_destination).not.toBeNull();
    expect(destinationIds.has(result.suggested_destination.id)).toBe(true);
    expect(result.suggested_destination.district).toBe('Sindhupalchok');
  });

  it('Kathmandu returns the city, the district and Kathmandu-district destinations', () => {
    const results = localities.search('Kathmandu', destinations);
    expect(results[0]).toMatchObject({ name: 'Kathmandu', municipality: 'Kathmandu Metropolitan City' });
    expect(results.some((result) => result.kind === 'district' && result.district === 'Kathmandu')).toBe(true);
    expect(results.some((result) => result.kind === 'destination' && result.district === 'Kathmandu')).toBe(true);
  });

  it.each([
    ['Pokhara', 'POKHARA - KASKI'],
    ['Damak', 'DAMAK - JHAPA'],
    ['Dharan', 'DHARAN - SUNSARI'],
    ['Birtamod', 'BIRTAMOD - JHAPA'],
    ['Nepalgunj', 'NEPALGUNJ - BANKE'],
    ['Tokha', 'TOKHA - KTM'],
  ])('outside-valley and named towns: %s maps exactly to %s', (query, destinationName) => {
    expect(first(query).suggested_destination).toMatchObject({ id: byName(destinationName).id });
  });

  it('a destination name is itself a result with its authoritative id', () => {
    const lekhnath = localities.search('Lekhnath', destinations).find((result) => result.kind === 'destination');
    expect(lekhnath.suggested_destination).toMatchObject({ id: byName('LEKHNATH - KASKI').id, name: 'LEKHNATH - KASKI', match: 'destination' });
  });

  it('a district returns its destinations for manual choice', () => {
    const results = localities.search('Chitwan', destinations);
    expect(results[0]).toMatchObject({ kind: 'district', district: 'Chitwan', suggested_destination: null });
    expect(results[0].district_destination_count).toBeGreaterThan(1);
  });

  it('tolerates partial text, spacing and romanization variants', () => {
    expect(first('hadiga').name).toBe('Hadigaun');
    expect(first('HADIGAON').name).toBe('Hadigaun');
    expect(first('basanta pur')).toMatchObject({ name: 'Basantapur', district: 'Kathmandu' });
    expect(first('Hadigaun,')).toMatchObject({ name: 'Hadigaun' });
  });

  it('ranks exact locality, then destination, then municipality, then district', () => {
    const kinds = localities.search('Tokha', destinations).map((result) => result.kind);
    expect(kinds.indexOf('locality')).toBeLessThan(kinds.indexOf('destination'));
    const bhaktapur = localities.search('Bhaktapur', destinations).map((result) => result.kind);
    expect(bhaktapur.indexOf('locality')).toBeLessThan(bhaktapur.indexOf('district'));
  });

  it('returns at most 8 results and nothing for one character', () => {
    expect(localities.search('ba', destinations).length).toBeLessThanOrEqual(8);
    expect(localities.search('b', destinations)).toEqual([]);
  });

  it('never suggests a destination that is not in the live list', () => {
    for (const query of ['Hadigaun', 'Basantapur', 'Sukute', 'Kathmandu', 'Pokhara', 'Thamel', 'Jawalakhel', 'Ilam', 'Jumla', 'Birgunj']) {
      for (const result of localities.search(query, destinations)) {
        if (result.suggested_destination) expect(destinationIds.has(result.suggested_destination.id)).toBe(true);
      }
    }
  });

  it('with no destination list, places are still found but nothing is suggested', () => {
    const results = localities.search('Hadigaun', []);
    expect(results[0]).toMatchObject({ name: 'Hadigaun', district: 'Kathmandu', suggested_destination: null });
  });

  it('ignores a courier rule whose destination is missing from the live list', () => {
    const withoutInsideValley = destinations.filter((destination) => destination.name !== 'INSIDE VALLEY - KTM');
    const result = localities.search('Hadigaun', withoutInsideValley)[0];
    expect(result.suggested_destination?.name).not.toBe('INSIDE VALLEY - KTM');
  });

  it('describes provider destinations with a parsed label and district', () => {
    const described = localities.describeDestinations([byName('TOKHA - KTM'), byName('IMADOL'), byName('POKHARA - KASKI')]);
    expect(described[0]).toMatchObject({ label: 'Tokha, Kathmandu', district: 'Kathmandu' });
    expect(described[1]).toMatchObject({ label: 'Imadol, Lalitpur', district: 'Lalitpur' });
    expect(described[2]).toMatchObject({ label: 'Pokhara, Kaski', district: 'Kaski' });
  });
});

describe('reverse geocoding proxy', () => {
  const originalFetch = global.fetch;
  const nominatim = {
    address: {
      road: 'Pragati Marga 1', neighbourhood: 'Bishalnagar', city_district: 'Kathmandu-04', city: 'Kathmandu Metropolitan City',
      county: 'Kathmandu', state: 'Bagamati Province', 'ISO3166-2-lvl4': 'NP-P3', country: 'Nepal', country_code: 'np',
    },
  };

  beforeEach(() => geocoder.clearCache());
  afterEach(() => { global.fetch = originalFetch; jest.restoreAllMocks(); });

  it('rounds the position before it leaves the server and sends identifying headers', async () => {
    const calls = [];
    global.fetch = jest.fn(async (url, options) => { calls.push({ url: new URL(String(url)), options }); return { ok: true, status: 200, json: async () => nominatim }; });
    const result = await geocoder.reverse({ latitude: 27.72156789, longitude: 85.33812345 }, destinations);
    expect(calls).toHaveLength(1);
    expect(calls[0].url.searchParams.get('lat')).toBe('27.722');
    expect(calls[0].url.searchParams.get('lon')).toBe('85.338');
    expect(calls[0].url.origin + calls[0].url.pathname).toBe(`${env.geocoder.baseUrl.replace(/\/$/, '')}/reverse`);
    expect(calls[0].options.headers['User-Agent']).toMatch(/^CaseVerse\//);
    expect(calls[0].options.headers.Referer).toBe(env.geocoder.referer);
    expect(result).toMatchObject({
      province: 'Bagmati Province', district: 'Kathmandu', municipality: 'Kathmandu Metropolitan City', ward: 4,
      locality: 'Bishalnagar', street: 'Pragati Marga 1', attribution: '© OpenStreetMap contributors',
    });
    expect(result.suggested_destination).toMatchObject({ id: byName('INSIDE VALLEY - KTM').id });
    // Positions are never echoed back.
    expect(JSON.stringify(result)).not.toMatch(/27\.72|85\.33/);
  });

  it('answers near-identical positions from the cache without a second upstream call', async () => {
    global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => nominatim }));
    await geocoder.reverse({ latitude: 27.72161, longitude: 85.33811 }, destinations);
    await geocoder.reverse({ latitude: 27.72159, longitude: 85.33789 }, destinations);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps upstream requests at least one second apart', async () => {
    const times = [];
    global.fetch = jest.fn(async () => { times.push(Date.now()); return { ok: true, status: 200, json: async () => nominatim }; });
    await Promise.all([
      geocoder.reverse({ latitude: 27.7, longitude: 85.3 }, destinations),
      geocoder.reverse({ latitude: 27.8, longitude: 85.4 }, destinations),
    ]);
    expect(times).toHaveLength(2);
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(1000);
  });

  it('does not log the position', async () => {
    const logs = [];
    for (const method of ['log', 'info', 'warn', 'error']) jest.spyOn(console, method).mockImplementation((...args) => logs.push(args.join(' ')));
    global.fetch = jest.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    await expect(geocoder.reverse({ latitude: 27.654321, longitude: 85.123456 }, destinations)).rejects.toMatchObject({ status: 503, code: 'geocoder_unavailable' });
    expect(logs.join('\n')).not.toMatch(/27\.65|85\.12/);
  });

  it('maps provider failures to clear errors and handles incomplete OSM results', async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 429, json: async () => ({}) }));
    await expect(geocoder.reverse({ latitude: 27.1, longitude: 85.1 }, destinations)).rejects.toMatchObject({ code: 'geocoder_busy' });

    geocoder.clearCache();
    global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ error: 'Unable to geocode' }) }));
    await expect(geocoder.reverse({ latitude: 27.2, longitude: 85.2 }, destinations)).rejects.toMatchObject({ status: 404, code: 'location_not_found' });

    geocoder.clearCache();
    global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ address: { country_code: 'in', state: 'Bihar' } }) }));
    await expect(geocoder.reverse({ latitude: 26.1, longitude: 85.3 }, destinations)).rejects.toMatchObject({ code: 'location_outside_nepal' });

    geocoder.clearCache();
    global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ address: { county: 'Kaski', country_code: 'np' } }) }));
    const partial = await geocoder.reverse({ latitude: 28.2, longitude: 83.9 }, destinations);
    expect(partial).toMatchObject({ district: 'Kaski', province: 'Gandaki Province', municipality: null, locality: null, street: null });
  });
});

describe('orders never carry a position', () => {
  const guest = {
    name: 'Test Guest', phone: '9800000000', province: 'Bagmati Province', district: 'Kathmandu', municipality: 'Kathmandu',
    area: 'Hadigaun', parcelmoover_destination_id: 'pm-1',
  };

  it('the guest order schema drops latitude and longitude', () => {
    const parsed = guestPlaceOrderSchema.parse({ items: [{ variant_id: 1, quantity: 1 }], guest: { ...guest, latitude: 27.72, longitude: 85.33 } });
    expect(parsed.guest).not.toHaveProperty('latitude');
    expect(parsed.guest).not.toHaveProperty('longitude');
  });

  it('the idempotency fingerprint ignores positions', () => {
    const items = [{ variant_id: 1, quantity: 1 }];
    const a = canonicalGuestRequest({ items, guest });
    const b = canonicalGuestRequest({ items, guest: { ...guest, latitude: 27.72, longitude: 85.33 } });
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).not.toMatch(/27\.72/);
  });
});
