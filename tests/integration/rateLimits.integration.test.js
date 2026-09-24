'use strict';

/**
 * Sign-in limits must stop password guessing without locking out customers
 * who share one public IP (mobile CGNAT): only failed attempts count.
 * DB-backed against caseverse_e2e (fixture accounts only).
 */

const { api, db } = require('./helpers');
const { ACCOUNTS, passwordFor } = require('../../scripts/e2e/fixtureData');

afterAll(() => db.sequelize.close());

describe('login rate limits', () => {
  it.each([
    ['customer', '/api/auth/login', 'customerC'],
    ['staff', '/api/staff/login', 'limitedStaff'],
  ])('%s: 25 successful sign-ins are never limited; 20 failures then block further attempts', async (_label, path, kind) => {
    const email = ACCOUNTS[kind].email;
    for (let i = 0; i < 25; i += 1) {
      expect((await api().post(path).send({ email, password: passwordFor(kind) })).status).toBe(200);
    }
    for (let i = 0; i < 20; i += 1) {
      expect((await api().post(path).send({ email, password: 'wrong-password-123' })).status).toBe(401);
    }
    const blocked = await api().post(path).send({ email, password: passwordFor(kind) });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('rate_limited');
  }, 60_000); // 45 bcrypt verifications
});
