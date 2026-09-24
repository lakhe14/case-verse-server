'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const errorHandler = require('../middleware/errorHandler');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'clearTestOrders.js');

function runClearTestOrders(env) {
  // Only the listed variables: nothing inherited can point at a real database.
  return spawnSync(process.execPath, [SCRIPT], { env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env }, encoding: 'utf8', timeout: 20000 });
}

describe('clearTestOrders is E2E-only', () => {
  it.each([
    ['development', { NODE_ENV: 'development' }],
    ['production', { NODE_ENV: 'production' }],
    ['e2e without the mutation opt-in', { NODE_ENV: 'e2e', E2E_DATABASE_URL: 'mysql://u:p@127.0.0.1:1/caseverse_e2e' }],
    ['e2e pointed at the dev database', { NODE_ENV: 'e2e', E2E_ALLOW_DB_MUTATION: 'true', E2E_DATABASE_URL: 'mysql://u:p@127.0.0.1:1/caseverse_db' }],
    ['e2e pointed at a non-e2e name', { NODE_ENV: 'e2e', E2E_ALLOW_DB_MUTATION: 'true', E2E_DATABASE_URL: 'mysql://u:p@127.0.0.1:1/caseverse' }],
  ])('refuses %s before touching any database', (_label, env) => {
    const result = runClearTestOrders(env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('E2E SAFETY GUARD');
    expect(result.stderr).toContain('only runs against the isolated E2E database');
  });
});

describe('errorHandler foreign-key fallback', () => {
  it('turns a raw FK violation into a safe 409 without constraint or SQL details', () => {
    const err = Object.assign(new Error('Cannot delete or update a parent row: a foreign key constraint fails (`caseverse`.`order_items`, CONSTRAINT `order_items_ibfk_2` FOREIGN KEY (`variant_id`) REFERENCES `product_variants` (`id`))'), {
      name: 'SequelizeForeignKeyConstraintError',
      sql: 'DELETE FROM `product_variants` WHERE `id` = 1',
      table: 'order_items',
      index: 'order_items_ibfk_2',
    });
    const res = { statusCode: 0, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    errorHandler(err, { requestId: 'req-1', originalUrl: '/api/admin/products/1' }, res, () => {});
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toEqual({ message: 'This record is referenced by other records and cannot be changed this way.', code: 'conflict', request_id: 'req-1' });
    expect(JSON.stringify(res.body)).not.toMatch(/order_items|ibfk|FOREIGN|DELETE|product_variants/);
  });
});

describe('errorHandler lock-conflict translation', () => {
  it.each(['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'])('turns %s into a safe, retryable 409', (dbCode) => {
    const err = Object.assign(new Error('Deadlock found when trying to get lock; try restarting transaction'), {
      name: 'SequelizeDatabaseError',
      parent: { code: dbCode, sql: 'SELECT `id` FROM `coupons` WHERE `code` = \'X\' FOR UPDATE' },
    });
    const res = { statusCode: 0, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    errorHandler(err, { requestId: 'req-2', originalUrl: '/api/orders' }, res, () => {});
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toEqual({ message: 'Another update was in progress. Please try again.', code: 'retry_conflict', request_id: 'req-2' });
    expect(JSON.stringify(res.body)).not.toMatch(/Deadlock|lock|SELECT|coupons/);
  });
});
