'use strict';

/**
 * Place search, reverse geocoding and destination descriptions through the
 * real HTTP stack. ParcelMoover and the geocoder use their E2E stubs
 * (PARCELMOOVER_MODE / GEOCODER_MODE = e2e-stub), so nothing leaves the machine.
 */

const { api, db, env } = require('./helpers');

afterAll(() => db.sequelize.close());

describe('geo endpoints', () => {
  it('runs against the stubs only', () => {
    expect(env.parcelmooverStub).toBe(true);
    expect(env.geocoder.stub).toBe(true);
  });

  it('describes destinations with a label and district while keeping the provider id', async () => {
    const res = await api().get('/api/shipping/parcelmoover/destinations');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'e2e-kathmandu', name: 'INSIDE VALLEY - KTM', label: 'Inside Valley, Kathmandu', district: 'Kathmandu' }),
    ]));
  });

  it('maps a familiar locality to a real destination', async () => {
    const res = await api().post('/api/geo/localities/search').send({ q: 'Hadigaun' });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.data[0]).toMatchObject({ name: 'Hadigaun', district: 'Kathmandu', suggested_destination: { id: 'e2e-kathmandu' } });
  });

  it('suggests nothing when the district has no destination', async () => {
    const res = await api().post('/api/geo/localities/search').send({ q: 'Jumla' });
    expect(res.status).toBe(200);
    for (const result of res.body.data) expect(result.suggested_destination).toBeNull();
  });

  it('validates search and reverse bodies', async () => {
    expect((await api().post('/api/geo/localities/search').send({})).status).toBe(422);
    expect((await api().post('/api/geo/reverse').send({ latitude: 200, longitude: 85 })).status).toBe(422);
  });

  it('reverse-geocodes to editable address fields and a suggestion, without echoing the position', async () => {
    const res = await api().post('/api/geo/reverse').send({ latitude: 27.7215678, longitude: 85.3381234 });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      province: 'Bagmati Province', district: 'Kathmandu', municipality: 'Kathmandu Metropolitan City', locality: 'Hadigaun',
      street: 'Hadigaun Marg', ward: 5, suggested_destination: { id: 'e2e-kathmandu' }, attribution: '© OpenStreetMap contributors',
    });
    expect(JSON.stringify(res.body)).not.toMatch(/27\.72|85\.33/);
  });
});
