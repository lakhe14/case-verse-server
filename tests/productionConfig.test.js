'use strict';

const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { passwordProblems } = require('../scripts/bootstrapAdmin');

const SERVER = path.resolve(__dirname, '..');
const secret = () => crypto.randomBytes(32).toString('hex');

/** Loads config/env.js in a child with exactly these variables (no .env values leak in). */
function loadProductionConfig(overrides) {
  const base = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    NODE_ENV: 'production',
    DATABASE_URL: 'mysql://caseverse_app:x@db.internal:3306/caseverse',
    CLIENT_ORIGIN: 'https://www.caseverse.example',
    JWT_ACCESS_SECRET: secret(),
    JWT_REFRESH_SECRET: secret(),
    GUEST_REPLAY_SECRET: secret(),
    PRIVATE_UPLOAD_DIR: path.resolve(path.sep, 'var', 'data', 'payment-proofs'),
    UPLOAD_DIR: path.resolve(path.sep, 'var', 'data', 'uploads'),
    PARCELMOOVER_API_KEY: 'k',
    PARCELMOOVER_BASE_URL: 'https://portal.parcelmoover.com/api/v1',
  };
  const env = { ...base, ...overrides };
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
  // dotenv never overrides variables already set; a blank value stands in for "unset".
  return spawnSync(process.execPath, ['-e', "require('./config/env'); console.log('ok')"], { cwd: SERVER, env, encoding: 'utf8' });
}

describe('production configuration guard', () => {
  it('starts with a complete, safe production configuration', () => {
    const result = loadProductionConfig({});
    expect(result.stderr).toBe('');
    expect(result.stdout.trim()).toBe('ok');
  });

  it.each([
    ['placeholder JWT secret', { JWT_ACCESS_SECRET: 'replace_with_secure_random_secret' }, 'JWT_ACCESS_SECRET'],
    ['short refresh secret', { JWT_REFRESH_SECRET: 'short' }, 'JWT_REFRESH_SECRET'],
    ['identical JWT secrets', { JWT_REFRESH_SECRET: 'a'.repeat(40), JWT_ACCESS_SECRET: 'a'.repeat(40) }, 'must differ'],
    ['guest replay secret reusing the refresh secret', { GUEST_REPLAY_SECRET: 'b'.repeat(40), JWT_REFRESH_SECRET: 'b'.repeat(40) }, 'GUEST_REPLAY_SECRET'],
    ['missing guest replay secret', { GUEST_REPLAY_SECRET: '' }, 'GUEST_REPLAY_SECRET'],
    ['localhost origin', { CLIENT_ORIGIN: 'http://localhost:5173' }, 'CLIENT_ORIGIN'],
    ['wildcard origin', { CLIENT_ORIGIN: 'https://*.caseverse.example' }, 'CLIENT_ORIGIN'],
    ['root database user', { DATABASE_URL: 'mysql://root:x@db.internal:3306/caseverse' }, 'must not be root'],
    ['development database', { DATABASE_URL: 'mysql://caseverse_app:x@db.internal:3306/caseverse_db' }, 'development, E2E or test'],
    ['relative proof directory', { PRIVATE_UPLOAD_DIR: 'private-uploads' }, 'PRIVATE_UPLOAD_DIR must be an absolute path'],
    ['proof directory inside public uploads', { PRIVATE_UPLOAD_DIR: path.resolve(path.sep, 'var', 'data', 'uploads', 'proofs') }, 'inside the public UPLOAD_DIR'],
    ['missing ParcelMoover key', { PARCELMOOVER_API_KEY: '' }, 'PARCELMOOVER_API_KEY'],
  ])('refuses %s, naming the variable but not its value', (_label, overrides, message) => {
    const result = loadProductionConfig(overrides);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Refusing to start in production');
    expect(result.stderr).toContain(message);
    for (const value of Object.values(overrides)) if (value && value.length > 20) expect(result.stderr).not.toContain(value);
  });
});

describe('admin bootstrap password policy', () => {
  const who = { name: 'Launch Owner', email: 'owner@caseverse.example' };
  it('accepts a long mixed password', () => {
    expect(passwordProblems('Tq7#vW2m!Lp9xZ', who)).toEqual([]);
  });
  it.each([
    ['too short', 'Aa1!aa'],
    ['one character class', 'abcdefghijklmnopq'],
    ['contains the email name', 'Owner-2026-Strong!'],
    ['contains the store name', 'CaseVerse-2026-Strong!'],
    ['contains password', 'MyPassword-2026!!'],
  ])('rejects %s', (_label, password) => {
    expect(passwordProblems(password, who).length).toBeGreaterThan(0);
  });
});
