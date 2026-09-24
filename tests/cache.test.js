'use strict';

const cache = require('../services/cache.service');
const ApiError = require('../utils/ApiError');
const FakeRedis = require('./support/fakeRedis');

const notFound = () => ApiError.notFound('Product not found', 'product_not_found');

let redis;
beforeEach(() => {
  redis = new FakeRedis();
  cache.setClientForTests(redis);
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
  cache.setClientForTests(undefined);
});

describe('cache-aside reads', () => {
  it('fills once, then serves an equal copy that callers cannot corrupt', async () => {
    const loader = jest.fn(async () => ({ name: 'Glossy white', variants: [{ id: 1, stock_quantity: null }] }));
    const first = await cache.readThrough('product:slug:glossy-white', loader);
    first.variants[0].stock_quantity = 7; // a caller overlaying live fields
    const second = await cache.readThrough('product:slug:glossy-white', loader);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(second).toEqual({ name: 'Glossy white', variants: [{ id: 1, stock_quantity: null }] });
    expect(cache.getStats()).toMatchObject({ misses: 1, fills: 1, hits: 1 });
    expect(redis.keys('catalog:g0:product:slug:glossy-white')).toHaveLength(1);
    expect(redis.ttlSeconds(redis.keys('product:slug:glossy-white')[0])).toBeLessThanOrEqual(300);
  });

  it('coalesces concurrent misses for one key into a single load', async () => {
    let release;
    const loader = jest.fn(() => new Promise((resolve) => { release = () => resolve({ ok: true }); }));
    const reads = Array.from({ length: 5 }, () => cache.readThrough('categories', loader));
    await new Promise((r) => setTimeout(r, 20));
    release();
    expect(await Promise.all(reads)).toEqual(Array(5).fill({ ok: true }));
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('refills an unreadable entry instead of failing', async () => {
    await redis.set('caseverse:v1:catalog:g0:categories', '{not json', 'EX', 60);
    const loader = jest.fn(async () => ['ok']);
    expect(await cache.readThrough('categories', loader)).toEqual(['ok']);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('skips the cache entirely for uncacheable requests', async () => {
    const loader = jest.fn(async () => ({ ok: true }));
    await cache.readThrough('product:slug:x', loader, { cacheable: false });
    await cache.readThrough('product:slug:x', loader, { cacheable: false });
    expect(loader).toHaveBeenCalledTimes(2);
    expect(redis.calls.get).toBe(0);
  });
});

describe('negative caching', () => {
  it('caches a miss briefly and rethrows the same safe 404 without reloading', async () => {
    const loader = jest.fn(async () => { throw notFound(); });
    for (let i = 0; i < 2; i += 1) {
      await expect(cache.readThrough('product:slug:ghost', loader, { notFound })).rejects.toMatchObject({ status: 404, code: 'product_not_found' });
    }
    expect(loader).toHaveBeenCalledTimes(1);
    expect(cache.getStats().negative_hits).toBe(1);
    const ttl = redis.ttlSeconds(redis.keys('product:slug:ghost')[0]);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(45);
  });

  it('never caches other errors', async () => {
    const loader = jest.fn(async () => { throw new Error('db down'); });
    for (let i = 0; i < 2; i += 1) await expect(cache.readThrough('product:slug:x', loader, { notFound })).rejects.toThrow('db down');
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('a catalog write clears the negative entry at once', async () => {
    let exists = false;
    const loader = jest.fn(async () => { if (!exists) throw notFound(); return { slug: 'ghost' }; });
    await expect(cache.readThrough('product:slug:ghost', loader, { notFound })).rejects.toMatchObject({ status: 404 });
    exists = true;
    expect(await cache.invalidateCatalog()).toBe(true);
    expect(await cache.readThrough('product:slug:ghost', loader, { notFound })).toEqual({ slug: 'ghost' });
  });
});

describe('invalidation', () => {
  it('each write moves every catalog key to a new generation', async () => {
    let name = 'v1';
    const loader = jest.fn(async () => ({ name }));
    await cache.readThrough('products:list:abc', loader);
    name = 'v2';
    await cache.invalidateCatalog();
    expect(await cache.readThrough('products:list:abc', loader)).toEqual({ name: 'v2' });
    expect(await cache.catalogGeneration()).toBe('1');
  });
});

describe('Redis failures never reach callers', () => {
  it('down: reads come from the loader, health is degraded, nothing throws', async () => {
    redis.mode = 'down';
    const loader = jest.fn(async () => ({ from: 'db' }));
    expect(await cache.readThrough('categories', loader)).toEqual({ from: 'db' });
    expect(await cache.readThrough('categories', loader)).toEqual({ from: 'db' });
    expect(loader).toHaveBeenCalledTimes(2);
    expect(await cache.status()).toBe('degraded');
    expect(console.warn).toHaveBeenCalledTimes(1); // rate limited
    expect(String(console.warn.mock.calls[0][0])).not.toMatch(/127\.0\.0\.1|redis:\/\//);
  });

  it('hang: each command is abandoned after a short timeout', async () => {
    redis.mode = 'hang';
    const started = Date.now();
    expect(await cache.readThrough('categories', async () => ['db'])).toEqual(['db']);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('a write while Redis is down stops this process trusting the cache until an invalidation lands', async () => {
    let name = 'old';
    const loader = jest.fn(async () => ({ name }));
    await cache.readThrough('product:slug:p', loader); // cached "old"
    redis.mode = 'down';
    name = 'new';
    expect(await cache.invalidateCatalog()).toBe(false);
    redis.mode = 'up';
    // Redis is back with the old entry still there; the pending invalidation is
    // retried before any read, so "old" is never served.
    expect(await cache.readThrough('product:slug:p', loader)).toEqual({ name: 'new' });
    expect(await cache.status()).toBe('ok');
  });

  it('disabled (no Redis configured): pure pass-through', async () => {
    cache.setClientForTests(null);
    const loader = jest.fn(async () => 1);
    await cache.readThrough('categories', loader);
    await cache.readThrough('categories', loader);
    expect(loader).toHaveBeenCalledTimes(2);
    expect(await cache.status()).toBe('disabled');
    expect(await cache.invalidateCatalog()).toBe(true);
  });
});
