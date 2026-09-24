'use strict';

/**
 * In-memory stand-in for the ioredis commands cache.service uses (get, set
 * with EX, incr, ping), with real TTL expiry and three modes:
 *   'up'   behaves like Redis
 *   'down' every command rejects like a refused connection
 *   'hang' every command never answers (exercises the command timeout)
 * Used only where no real Redis is available to the test run.
 */
class FakeRedis {
  constructor() {
    this.store = new Map();
    this.mode = 'up';
    this.calls = { get: 0, set: 0, incr: 0, ping: 0 };
  }

  async gate(command) {
    this.calls[command] += 1;
    if (this.mode === 'down') throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:6379'), { code: 'ECONNREFUSED' });
    if (this.mode === 'hang') await new Promise(() => {});
  }

  entry(key) {
    const item = this.store.get(key);
    if (!item) return null;
    if (item.expiresAt !== null && item.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return item;
  }

  async get(key) {
    await this.gate('get');
    return this.entry(key)?.value ?? null;
  }

  async set(key, value, mode, seconds) {
    await this.gate('set');
    this.store.set(key, { value: String(value), expiresAt: mode === 'EX' ? Date.now() + seconds * 1000 : null });
    return 'OK';
  }

  async incr(key) {
    await this.gate('incr');
    const next = Number(this.entry(key)?.value || 0) + 1;
    this.store.set(key, { value: String(next), expiresAt: null });
    return next;
  }

  async ping() {
    await this.gate('ping');
    return 'PONG';
  }

  /** Test helper: seconds left on a key, or null. */
  ttlSeconds(key) {
    const item = this.entry(key);
    return item && item.expiresAt !== null ? Math.round((item.expiresAt - Date.now()) / 1000) : null;
  }

  keys(pattern = '') {
    return [...this.store.keys()].filter((key) => this.entry(key) && key.includes(pattern));
  }
}

module.exports = FakeRedis;
