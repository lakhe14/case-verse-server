'use strict';

/**
 * OPTIONAL live provider check. Core E2E runs use the deterministic stub, so
 * a ParcelMoover outage never fails them. Run this one on demand:
 *   set E2E_PARCELMOOVER_LIVE=true&& npm run test:integration -- parcelmooverLive
 */

const { api, db, env } = require('./helpers');

const live = process.env.E2E_PARCELMOOVER_LIVE === 'true';
afterAll(() => db.sequelize.close());

(live ? describe : describe.skip)('ParcelMoover live integration (E2E_PARCELMOOVER_LIVE=true)', () => {
  it('lists real destinations and quotes a guest preview through the provider', async () => {
    expect(env.parcelmooverStub).toBe(false);
    const destinations = await api().get('/api/shipping/parcelmoover/destinations');
    expect(destinations.status).toBe(200);
    expect(destinations.body.data.length).toBeGreaterThan(0);
    const [destination] = destinations.body.data;
    const variant = await db.ProductVariant.findOne({ where: { is_active: true } });
    const preview = await api().post('/api/guest-checkout/preview').send({
      items: [{ variant_id: variant.id, quantity: 1 }],
      guest: { municipality: 'Kathmandu', province: 'Bagmati', parcelmoover_destination_id: destination.id },
    });
    expect(preview.status).toBe(200);
    expect(preview.body.data.shipping_amount).toBeGreaterThan(0);
    expect(preview.body.data.courier.destination_id).toBe(destination.id);
  });
});
