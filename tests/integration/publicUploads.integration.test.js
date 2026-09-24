'use strict';

/**
 * Public product images under /uploads may be embedded by the storefront on
 * another origin; payment proofs must never be reachable there.
 */

const fs = require('fs');
const path = require('path');
const { api, db, env } = require('./helpers');

const publicDir = path.resolve(__dirname, '..', '..', env.uploads.dir);
const image = `e2e-public-${Date.now()}.png`;
const proof = `e2e-private-${Date.now()}.png`;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

beforeAll(() => {
  fs.mkdirSync(publicDir, { recursive: true });
  fs.mkdirSync(env.uploads.proofDir, { recursive: true });
  fs.writeFileSync(path.join(publicDir, image), PNG);
  fs.writeFileSync(path.join(env.uploads.proofDir, proof), PNG);
});
afterAll(async () => {
  fs.rmSync(path.join(publicDir, image), { force: true });
  fs.rmSync(path.join(env.uploads.proofDir, proof), { force: true });
  await db.sequelize.close();
});

it('public images are served with a cross-origin resource policy; the API keeps same-origin', async () => {
  const res = await api().get(`/uploads/${image}`);
  expect(res.status).toBe(200);
  expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
  const health = await api().get('/api/health');
  expect(health.headers['cross-origin-resource-policy']).toBe('same-origin');
});

it('payment proofs are never reachable through /uploads', async () => {
  expect(path.relative(publicDir, env.uploads.proofDir).startsWith('..')).toBe(true);
  expect((await api().get(`/uploads/${proof}`)).status).toBe(404);
  const relativeProof = path.relative(publicDir, path.join(env.uploads.proofDir, proof)).split(path.sep).join('/');
  for (const attempt of [`/uploads/${relativeProof}`, `/uploads/${encodeURIComponent(relativeProof)}`, '/uploads/']) {
    const res = await api().get(attempt);
    expect([400, 403, 404]).toContain(res.status);
    expect(res.body?.length ?? 0).not.toBe(PNG.length);
  }
});
