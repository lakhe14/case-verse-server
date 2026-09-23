'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const { Op } = require('sequelize');
const {
  assertE2eDatabaseName, assertE2eDirectory, assertE2eEnvironment, databaseNameFromUrl, E2E_TMP_ROOT,
} = require('../config/e2eGuard');

const SERVER_ROOT = path.resolve(__dirname, '..');
// Port 1 is never a MySQL server: if a guard ever let a script through, the
// failure would be a connection error instead of the guard message below.
const DEV_URL = 'mysql://root@127.0.0.1:1/caseverse_db';
const E2E_URL = 'mysql://root@127.0.0.1:1/caseverse_e2e';

function runScript(script, env, args = []) {
  // A clean child environment: nothing inherited from the jest process or server/.env overrides these.
  const result = spawnSync(process.execPath, [path.join(SERVER_ROOT, script), ...args], {
    cwd: SERVER_ROOT,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env },
    encoding: 'utf8',
    timeout: 20_000,
  });
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

describe('E2E database guard', () => {
  it.each(['caseverse_db', 'caseverse', 'caseverse_test', 'caseverse_unit_test', 'caseverse_e2e_backup', 'e2e', 'CASEVERSE_E2E', ''])(
    'refuses database name %p', (name) => {
      expect(() => assertE2eDatabaseName(name)).toThrow(/E2E SAFETY GUARD/);
    }
  );

  it('accepts only *_e2e names', () => {
    expect(assertE2eDatabaseName('caseverse_e2e')).toBe('caseverse_e2e');
    expect(databaseNameFromUrl(E2E_URL)).toBe('caseverse_e2e');
  });

  it.each(['development', 'test', 'production', 'E2E', undefined])('refuses NODE_ENV=%p', (nodeEnv) => {
    expect(() => assertE2eEnvironment({ NODE_ENV: nodeEnv, E2E_DATABASE_URL: E2E_URL })).toThrow(/NODE_ENV must be exactly "e2e"/);
  });

  it('requires an explicit E2E_DATABASE_URL and never falls back to DATABASE_URL', () => {
    expect(() => assertE2eEnvironment({ NODE_ENV: 'e2e', DATABASE_URL: E2E_URL })).toThrow(/E2E_DATABASE_URL is not set/);
    expect(() => assertE2eEnvironment({ NODE_ENV: 'e2e', E2E_DATABASE_URL: E2E_URL, DATABASE_URL: E2E_URL })).toThrow(/must differ/);
  });

  it('requires the mutation opt-in for setup and cleanup', () => {
    expect(() => assertE2eEnvironment({ NODE_ENV: 'e2e', E2E_DATABASE_URL: E2E_URL }, { mutation: true })).toThrow(/E2E_ALLOW_DB_MUTATION=true/);
    expect(assertE2eEnvironment({ NODE_ENV: 'e2e', E2E_DATABASE_URL: E2E_URL, E2E_ALLOW_DB_MUTATION: 'true' }, { mutation: true }))
      .toEqual({ databaseName: 'caseverse_e2e' });
  });
});

describe('E2E upload directory isolation', () => {
  it('rejects the real private proof directory, the .tmp root, and traversal', () => {
    for (const dir of [
      path.join(SERVER_ROOT, 'private-uploads', 'payment-proofs'),
      path.join(SERVER_ROOT, 'uploads'),
      E2E_TMP_ROOT,
      path.join(E2E_TMP_ROOT, '..', 'private-uploads'),
    ]) {
      expect(() => assertE2eDirectory(dir, 'PRIVATE_UPLOAD_DIR')).toThrow(/inside server\/\.tmp/);
    }
  });

  it('accepts a dedicated folder inside server/.tmp', () => {
    const dir = path.join(E2E_TMP_ROOT, 'e2e-payment-proofs');
    expect(assertE2eDirectory(dir)).toBe(dir);
  });

  it('config/env.js refuses an E2E process whose proof directory points at private-uploads', () => {
    const { status, output } = runScript('config/env.js', {
      NODE_ENV: 'e2e', E2E_DATABASE_URL: E2E_URL, PRIVATE_UPLOAD_DIR: 'private-uploads/payment-proofs', UPLOAD_DIR: '.tmp/e2e-uploads', JWT_ACCESS_SECRET: 'x', JWT_REFRESH_SECRET: 'y',
    });
    expect(status).not.toBe(0);
    expect(output).toMatch(/PRIVATE_UPLOAD_DIR must be inside server\/\.tmp/);
  });
});

describe('E2E scripts refuse unsafe databases before connecting', () => {
  const base = { NODE_ENV: 'e2e', E2E_ALLOW_DB_MUTATION: 'true' };

  it.each([
    ['scripts/e2e/cleanup.js', []],
    ['scripts/e2e/setup.js', []],
    ['scripts/e2e/reset.js', ['--confirm-drop-e2e']],
  ])('%s exits non-zero for caseverse_db', (script, args) => {
    const { status, output } = runScript(script, { ...base, E2E_DATABASE_URL: DEV_URL }, args);
    expect(status).not.toBe(0);
    expect(output).toMatch(/E2E SAFETY GUARD: refusing database "caseverse_db"/);
    expect(output).not.toMatch(/ECONNREFUSED|connect/i);
  });

  it.each(['mysql://root@127.0.0.1:1/caseverse', 'mysql://root@127.0.0.1:1/caseverse_test', 'mysql://root@127.0.0.1:1/shop_e2e_copy'])(
    'cleanup exits non-zero for %s', (url) => {
      const { status, output } = runScript('scripts/e2e/cleanup.js', { ...base, E2E_DATABASE_URL: url });
      expect(status).not.toBe(0);
      expect(output).toMatch(/E2E SAFETY GUARD/);
    }
  );

  it('cleanup refuses without NODE_ENV=e2e or without the mutation opt-in', () => {
    const wrongEnv = runScript('scripts/e2e/cleanup.js', { NODE_ENV: 'development', E2E_ALLOW_DB_MUTATION: 'true', E2E_DATABASE_URL: E2E_URL });
    expect(wrongEnv.status).not.toBe(0);
    expect(wrongEnv.output).toMatch(/NODE_ENV must be exactly "e2e"/);
    const noOptIn = runScript('scripts/e2e/cleanup.js', { NODE_ENV: 'e2e', E2E_DATABASE_URL: E2E_URL });
    expect(noOptIn.status).not.toBe(0);
    expect(noOptIn.output).toMatch(/E2E_ALLOW_DB_MUTATION=true is required/);
  });

  it('the E2E API server refuses caseverse_db', () => {
    const { status, output } = runScript('scripts/e2e/server.js', { NODE_ENV: 'e2e', E2E_DATABASE_URL: DEV_URL });
    expect(status).not.toBe(0);
    expect(output).toMatch(/E2E SAFETY GUARD: refusing database "caseverse_db"/);
  });
});

describe('E2E cleanup scoping and run ids', () => {
  const { buildOrderScope } = require('../scripts/e2e/fixtures');
  const { newRunId } = require('../scripts/e2e/loadEnv');

  it('always scopes guest orders to the E2E tag and customer orders to fixture users', () => {
    const scope = buildOrderScope({ userIds: [7, 8] });
    const [guestClause, userClause] = scope[Op.or];
    expect(guestClause.user_id).toBeNull();
    const tags = guestClause[Op.or];
    expect(tags).toEqual([{ guest_name: { [Op.like]: 'E2E%' } }, { guest_delivery_notes: { [Op.like]: '%E2E-%' } }]);
    expect(userClause).toEqual({ user_id: { [Op.in]: [7, 8] } });
  });

  it('never produces an unscoped filter when no fixture users exist', () => {
    const scope = buildOrderScope({});
    expect(scope[Op.or]).toHaveLength(1);
    expect(scope[Op.or][0].user_id).toBeNull();
  });

  it('narrows guest orders to one run id', () => {
    const scope = buildOrderScope({ userIds: [], runId: 'E2E-20260924-abc123' });
    expect(scope[Op.or][0]).toEqual({ user_id: null, guest_delivery_notes: { [Op.like]: '%E2E-20260924-abc123%' } });
  });

  it('generates distinct, tagged run ids', () => {
    const a = newRunId();
    const b = newRunId();
    expect(a).toMatch(/^E2E-\d{8}-[0-9a-f]{6}$/);
    expect(a).not.toBe(b);
  });
});

describe('ParcelMoover E2E stub', () => {
  it('is disabled outside NODE_ENV=e2e even when requested', () => {
    const previous = process.env.PARCELMOOVER_MODE;
    process.env.PARCELMOOVER_MODE = 'e2e-stub';
    try {
      jest.isolateModules(() => {
        const env = require('../config/env');
        expect(env.isE2e).toBe(false);
        expect(env.parcelmooverStub).toBe(false);
      });
    } finally {
      if (previous === undefined) delete process.env.PARCELMOOVER_MODE;
      else process.env.PARCELMOOVER_MODE = previous;
    }
  });
});
