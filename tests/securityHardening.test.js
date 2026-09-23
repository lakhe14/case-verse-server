'use strict';

const errorHandler = require('../middleware/errorHandler');
const adminValidators = require('../validators/admin.validators');

describe('client-safe error responses', () => {
  it('never returns an internal stack or driver message', () => {
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const err = new Error('ER_ACCESS_DENIED_ERROR mysql://root:secret@127.0.0.1:3307/caseverse_db');
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});

    errorHandler(err, {
      requestId: 'request-test-id',
      method: 'GET',
      originalUrl: '/api/guest-checkout/orders/opaque-token',
    }, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      error: { message: 'Something went wrong', code: 'internal_error', request_id: 'request-test-id' },
    });
    expect(log.mock.calls[0][0].url).toBe('/api/guest-checkout/orders/<redacted>');
    log.mockRestore();
  });
});

describe('admin payment input boundaries', () => {
  it('bounds payment queue pagination and review notes', () => {
    expect(() => adminValidators.paymentQueueQuery.parse({ limit: 51 })).toThrow();
    expect(() => adminValidators.paymentReviewSchema.parse({ note: 'x'.repeat(501) })).toThrow();
    expect(adminValidators.paymentQueueQuery.parse({ page: '1', limit: '20' })).toMatchObject({ page: 1, limit: 20 });
  });
});
