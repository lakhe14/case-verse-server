'use strict';

/**
 * A real 500: a genuine MySQL error (unknown column, with a customer-like value
 * in the WHERE clause) raised inside a real request against caseverse_e2e.
 * The client gets a generic 500 with a request id; the server log line is
 * structured and carries no SQL, value, stack or path.
 */

const { api, db } = require('./helpers');

afterAll(() => db.sequelize.close());

const VALUE = 'sita.sharma@example.com';

it('a database failure during a request is safe in both the response and the log', async () => {
  const original = db.Product.findOne.bind(db.Product);
  jest.spyOn(db.Product, 'findOne').mockImplementationOnce((options) => original({ ...options, where: { ...options.where, no_such_column: VALUE } }));
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const res = await api().get('/api/products/glossy-white');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: { message: 'Something went wrong', code: 'internal_error', request_id: expect.any(String) } });
    expect(res.headers['x-request-id'] || res.body.error.request_id).toBeTruthy();
    expect(JSON.stringify(res.body)).not.toMatch(/SELECT|Sequelize|no_such_column|sita|Unknown column|caseverse_e2e|[\\/]server[\\/]/i);

    const lines = log.mock.calls.map((call) => call.join(' '));
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]);
    expect(record).toMatchObject({ event: 'http_error', status: 500, method: 'GET', path: '/api/products/glossy-white', request_id: res.body.error.request_id, category: 'database_error', error_class: 'SequelizeDatabaseError', code: 'ER_BAD_FIELD_ERROR' });
    expect(lines[0]).not.toMatch(/SELECT|no_such_column|sita|Unknown column|caseverse_e2e|at [A-Za-z]|stack|message/i);
  } finally {
    jest.restoreAllMocks();
  }
});
