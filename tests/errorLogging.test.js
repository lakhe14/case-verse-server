'use strict';

/**
 * Server-side logs for 5xx and process failures must be structured and free
 * of SQL, bind values, customer data, tokens, credentials and stacks. Unit
 * tests run with NODE_ENV=test, which logs exactly like production (only
 * development adds redacted message/stack).
 */

const errorHandler = require('../middleware/errorHandler');
const { classifyError, redactSecrets, logProcessError } = require('../utils/safeLog');
const email = require('../services/email.service');
const env = require('../config/env');

const CUSTOMER = { name: 'Sita Sharma', phone: '9801234567', email: 'sita@example.com', address: 'Baneshwor Road 12' };
// Logs may name the error class (e.g. SequelizeDatabaseError); responses may not.
const LOG_FORBIDDEN_PARTS = [
  'SELECT', 'INSERT INTO', 'at [A-Za-z]', 'server[\\\\/]', 'mysql://',
  CUSTOMER.name, CUSTOMER.phone, CUSTOMER.email, CUSTOMER.address,
  'uq_users_email', 'Bearer', 'eyJ', 'guest-token-abcdef', 's3cr3t',
];
const FORBIDDEN = new RegExp([...LOG_FORBIDDEN_PARTS, 'Sequelize'].join('|'), 'i');
const LOG_FORBIDDEN = new RegExp(LOG_FORBIDDEN_PARTS.join('|'), 'i');

/** A realistic Sequelize / MySQL failure carrying SQL, values and a stack. */
function databaseError() {
  const sql = `INSERT INTO \`orders\` (\`guest_name\`,\`guest_phone\`,\`guest_area\`) VALUES ('${CUSTOMER.name}','${CUSTOMER.phone}','${CUSTOMER.address}')`;
  const parent = Object.assign(new Error(`Duplicate entry '${CUSTOMER.email}' for key 'uq_users_email'`), { code: 'ER_DUP_ENTRY', errno: 1062, sql, parameters: [CUSTOMER.name, CUSTOMER.phone] });
  return Object.assign(new Error(parent.message), {
    name: 'SequelizeDatabaseError',
    parent,
    original: parent,
    sql,
    parameters: [CUSTOMER.name, CUSTOMER.phone],
    stack: 'SequelizeDatabaseError: Duplicate entry\n    at Query.formatError (E:\\CaseVerse_System\\server\\node_modules\\sequelize\\lib\\query.js:1:1)',
  });
}

const mockRes = () => ({ statusCode: 0, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });

let log;
beforeEach(() => { log = jest.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => jest.restoreAllMocks());

describe('5xx responses and logs', () => {
  it('a database failure returns a generic 500 and logs one structured, data-free record', () => {
    const res = mockRes();
    errorHandler(databaseError(), {
      requestId: 'req-500',
      method: 'POST',
      originalUrl: '/api/guest-checkout/orders/guest-token-abcdef/payment-proof?phone=9801234567',
      headers: { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJpZCI6MX0.s3cr3tsignature' },
      body: CUSTOMER,
    }, res, () => {});

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: { message: 'Something went wrong', code: 'internal_error', request_id: 'req-500' } });
    expect(JSON.stringify(res.body)).not.toMatch(FORBIDDEN);

    expect(log).toHaveBeenCalledTimes(1);
    const line = log.mock.calls[0][0];
    expect(typeof line).toBe('string');
    expect(line).not.toMatch(LOG_FORBIDDEN);
    expect(JSON.parse(line)).toEqual({
      level: 'error',
      time: expect.any(String),
      event: 'http_error',
      request_id: 'req-500',
      method: 'POST',
      path: '/api/guest-checkout/orders/<redacted>/payment-proof',
      status: 500,
      category: 'constraint_conflict',
      error_class: 'SequelizeDatabaseError',
      code: 'ER_DUP_ENTRY',
    });
  });

  it('a plain programming error logs only its class', () => {
    const res = mockRes();
    errorHandler(new TypeError(`Cannot read properties of undefined (reading '${CUSTOMER.email}')`), { requestId: 'r2', method: 'GET', originalUrl: '/api/orders/7' }, res, () => {});
    const record = JSON.parse(log.mock.calls[0][0]);
    expect(record).toMatchObject({ category: 'unexpected_error', error_class: 'TypeError', code: null, path: '/api/orders/7' });
    expect(log.mock.calls[0][0]).not.toMatch(LOG_FORBIDDEN);
  });

  it('4xx business errors are not logged as server errors', () => {
    errorHandler(Object.assign(new Error('x'), { name: 'SequelizeUniqueConstraintError', errors: [] }), { requestId: 'r3', method: 'POST', originalUrl: '/api/auth/register' }, mockRes(), () => {});
    expect(log).not.toHaveBeenCalled();
  });
});

describe('classification', () => {
  it.each([
    [{ name: 'SequelizeForeignKeyConstraintError' }, 'constraint_conflict'],
    [{ name: 'SequelizeDatabaseError', parent: { code: 'ER_LOCK_DEADLOCK' } }, 'transaction_conflict'],
    [{ name: 'SequelizeConnectionRefusedError', parent: { code: 'ECONNREFUSED' } }, 'database_error'],
    [{ name: 'SequelizeDatabaseError', parent: { code: 'ER_BAD_FIELD_ERROR' } }, 'database_error'],
    [new RangeError('x'), 'unexpected_error'],
    ['a string rejection', 'unexpected_error'],
  ])('%j -> %s', (error, category) => {
    expect(classifyError(error).category).toBe(category);
  });

  it('never passes through a code that could carry data', () => {
    expect(classifyError({ code: `Duplicate '${CUSTOMER.email}'` }).code).toBeNull();
  });
});

describe('process-level and email logging', () => {
  it('startup and escaped failures log category and code only', () => {
    logProcessError('database_connect_failed', Object.assign(new Error("Access denied for user 'caseverse_app'@'10.0.0.5' (using password: YES)"), { code: 'ER_ACCESS_DENIED_ERROR' }));
    const line = log.mock.calls[0][0];
    expect(JSON.parse(line)).toMatchObject({ event: 'database_connect_failed', category: 'database_error', code: 'ER_ACCESS_DENIED_ERROR' });
    expect(line).not.toMatch(/caseverse_app|10\.0\.0\.5|Access denied/);
  });

  it('outside development the email stub never prints the address or a reset link', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const info = jest.spyOn(console, 'info').mockImplementation(() => {});
    const saved = { isTest: env.isTest, nodeEnv: env.nodeEnv };
    Object.assign(env, { isTest: false, nodeEnv: 'production' });
    try {
      await email.sendPasswordResetEmail({ name: CUSTOMER.name, email: CUSTOMER.email }, 'a'.repeat(64));
    } finally {
      Object.assign(env, saved);
    }
    expect(info).not.toHaveBeenCalled();
    const output = warn.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(JSON.parse(warn.mock.calls[0][0])).toMatchObject({ event: 'email_not_sent', reason: 'no_email_provider_configured' });
    expect(output).not.toMatch(new RegExp(`${CUSTOMER.email}|${CUSTOMER.name}|a{64}|reset-password`));
  });

  it('development redaction still strips credentials and tokens', () => {
    const text = redactSecrets('connect mysql://app:pw@db:3306/x Bearer eyJabcdefghijk.eyJabcdefghijk.sig token=abc /api/guest-checkout/orders/xyz123 ' + 'f'.repeat(48));
    expect(text).not.toMatch(/app:pw|eyJabc|token=abc|xyz123|f{48}/);
  });
});
