'use strict';

const { staleUnpaidDecision } = require('../services/orderExpiry.service');

const now = new Date('2026-09-24T12:00:00Z');
const minutesAgo = (n) => new Date(now.getTime() - n * 60 * 1000);
const hoursAgo = (n) => minutesAgo(n * 60);

const order = (status = 'pending') => ({ status });
const payment = (status, updatedAt = hoursAgo(100)) => ({ status, updated_at: updatedAt });
const hold = (status, expiresAt) => ({ status, expires_at: expiresAt });
const lapsed = [hold('active', minutesAgo(1))];
const decide = (o, p, r) => staleUnpaidDecision({ order: o, payment: p, reservations: r, now });

describe('staleUnpaidDecision', () => {
  it('cancels a pending order whose unpaid hold lapsed (swept or not)', () => {
    expect(decide(order(), payment('pending'), lapsed)).toEqual({ eligible: true, reason: 'eligible' });
    expect(decide(order(), payment('pending'), [hold('expired', minutesAgo(90))]).eligible).toBe(true);
  });

  it('cancels proof_uploaded, cod_pending and rejected orders once their window lapsed', () => {
    for (const status of ['proof_uploaded', 'cod_pending', 'rejected']) {
      expect(decide(order(), payment(status, hoursAgo(73)), lapsed).eligible).toBe(true);
    }
  });

  it('keeps any order whose hold is still live', () => {
    const live = [hold('active', minutesAgo(-10))];
    for (const status of ['pending', 'proof_uploaded', 'cod_pending', 'rejected']) {
      expect(decide(order(), payment(status), live)).toEqual({ eligible: false, reason: 'hold_active' });
    }
  });

  it('gives a proof or COD request made after the hold lapsed its full review window', () => {
    expect(decide(order(), payment('proof_uploaded', hoursAgo(71)), lapsed).reason).toBe('recent_payment_activity');
    expect(decide(order(), payment('cod_pending', hoursAgo(71)), lapsed).reason).toBe('recent_payment_activity');
    expect(decide(order(), payment('rejected', minutesAgo(30)), lapsed).reason).toBe('recent_payment_activity');
  });

  it('never cancels confirmed payments or non-pending orders', () => {
    expect(decide(order(), payment('approved'), lapsed).reason).toBe('payment_confirmed');
    expect(decide(order(), payment('cod_confirmed'), lapsed).reason).toBe('payment_confirmed');
    for (const status of ['processing', 'shipped', 'delivered', 'cancelled']) {
      expect(decide(order(status), payment('pending'), lapsed).reason).toBe('order_not_pending');
    }
  });

  it('leaves legacy orders and holds that already moved stock alone', () => {
    expect(decide(order(), null, lapsed).reason).toBe('legacy_no_payment_record');
    expect(decide(order(), payment('pending'), []).reason).toBe('legacy_no_reservations');
    expect(decide(order(), payment('pending'), [hold('committed', minutesAgo(1))]).reason).toBe('reservation_not_open');
    expect(decide(order(), payment('pending'), [...lapsed, hold('released', minutesAgo(1))]).reason).toBe('reservation_not_open');
  });
});
