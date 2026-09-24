'use strict';

/**
 * Optional Redis read cache for public catalog data. An optimization only:
 * never a source of truth, never consulted for stock, prices at checkout,
 * coupons, payments, auth or guest tokens.
 *
 * Every Redis call is bounded (ioredis connect/command timeouts plus our own
 * race) and any failure falls through to the loader (MySQL). No cache error
 * ever reaches a caller.
 *
 * Invalidation is by generation: every catalog key embeds the current
 * catalog generation (<prefix>:v1:catalog:g<N>:...), and each committed
 * catalog write increments it, so all catalog entries (details, lists,
 * categories, negative "not found" markers) become unreachable at once and
 * simply expire. Readers read the generation BEFORE querying MySQL, and writers
 * bump it only AFTER their transaction commits, so a slow reader can only ever
 * fill a generation that is already dead.
 *
 * Recommended deployment: a dedicated Redis with maxmemory set and
 * maxmemory-policy allkeys-lru; nothing depends on persistence.
 */

const env = require('../config/env');

const NOT_FOUND = '__caseverse_not_found__';
const stats = { hits: 0, misses: 0, negative_hits: 0, fills: 0, bypassed: 0, errors: 0, invalidations: 0 };

let client = null;
let injected; // test seam: undefined = use config, null = disabled, object = client
// A catalog write whose invalidation could not reach Redis: this process
// stops trusting the cache until a later invalidation succeeds.
let invalidationPending = false;
let lastWarnAt = 0;

function warn(error) {
  stats.errors += 1;
  const now = Date.now();
  if (now - lastWarnAt < 60_000) return;
  lastWarnAt = now;
  // Code/name only: never the URL, credentials or key contents.
  console.warn(`Cache unavailable, serving from the database (${error?.code || error?.name || 'error'})`);
}

function getClient() {
  if (injected !== undefined) return injected;
  if (!env.cache.enabled) return null;
  if (!client) {
    const Redis = require('ioredis');
    client = new Redis(env.cache.url, {
      connectTimeout: env.cache.connectTimeoutMs,
      commandTimeout: env.cache.commandTimeoutMs,
      maxRetriesPerRequest: 0,
      enableOfflineQueue: false, // while disconnected, commands fail at once
      retryStrategy: (times) => Math.min(times * 500, 10_000), // keep reconnecting in the background
    });
    client.on('error', warn);
  }
  return client;
}

function withTimeout(promise) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('Cache command timed out'), { code: 'CACHE_TIMEOUT' })), env.cache.commandTimeoutMs * 2);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Runs one Redis command. Returns { ok, value }; never throws. */
async function run(command) {
  const redis = getClient();
  if (!redis) return { ok: false };
  try {
    return { ok: true, value: await withTimeout(Promise.resolve().then(() => command(redis))) };
  } catch (error) {
    warn(error);
    return { ok: false };
  }
}

const key = (...parts) => `${env.cache.prefix}:v1:${parts.join(':')}`;
const GENERATION_KEY = () => key('catalog', 'generation');

async function catalogGeneration() {
  if (invalidationPending) {
    // Retry the missed invalidation first; trust nothing until it lands.
    if (!(await invalidateCatalog())) return null;
  }
  const result = await run((redis) => redis.get(GENERATION_KEY()));
  return result.ok ? result.value || '0' : null;
}

const inflight = new Map();
const clone = (value) => (value == null ? value : structuredClone(value));

/**
 * Cache-aside read of a public catalog DTO (plain JSON).
 *   name       key suffix inside the current generation (no PII)
 *   loader     async () => DTO from MySQL; its ApiError propagates unchanged
 *   notFound   () => the ApiError a missing item produces; enables short
 *              negative caching (a cached miss rethrows a fresh copy)
 *   cacheable  false to skip the cache for this request (e.g. malformed input)
 * Concurrent misses for the same key in this process share one load.
 */
async function readThrough(name, loader, { notFound, cacheable = true, ttlSeconds = env.cache.defaultTtlSeconds } = {}) {
  const isNotFound = (error) => Boolean(notFound) && error?.status === 404 && error?.code === notFound().code;
  if (!cacheable || !getClient()) {
    stats.bypassed += 1;
    return loader();
  }
  const generation = await catalogGeneration();
  if (generation === null) {
    stats.bypassed += 1;
    return loader();
  }
  const fullKey = key('catalog', `g${generation}`, name);
  const got = await run((redis) => redis.get(fullKey));
  if (!got.ok) {
    stats.bypassed += 1;
    return loader();
  }
  if (got.value === NOT_FOUND && notFound) {
    stats.negative_hits += 1;
    throw notFound();
  }
  if (got.value != null) {
    try {
      const value = JSON.parse(got.value);
      stats.hits += 1;
      return value;
    } catch {
      // Unreadable entry: fall through and refill it.
    }
  }
  stats.misses += 1;
  if (!inflight.has(fullKey)) {
    const fill = (async () => {
      try {
        const value = await loader();
        await run((redis) => redis.set(fullKey, JSON.stringify(value), 'EX', ttlSeconds));
        stats.fills += 1;
        return value;
      } catch (error) {
        if (isNotFound(error)) await run((redis) => redis.set(fullKey, NOT_FOUND, 'EX', env.cache.negativeTtlSeconds));
        throw error;
      }
    })().finally(() => inflight.delete(fullKey));
    inflight.set(fullKey, fill);
  }
  // Each caller gets its own copy: callers overlay live fields onto it.
  return clone(await inflight.get(fullKey));
}

/**
 * After a committed catalog write: every catalog entry becomes unreachable.
 * Returns false if Redis could not be reached (this process then bypasses the
 * cache until an invalidation succeeds).
 */
async function invalidateCatalog() {
  if (!getClient()) return true;
  const result = await run((redis) => redis.incr(GENERATION_KEY()));
  invalidationPending = !result.ok;
  if (result.ok) stats.invalidations += 1;
  return result.ok;
}

/** For /api/health: 'disabled' | 'ok' | 'degraded'. Never includes the URL. */
async function status() {
  if (!getClient()) return 'disabled';
  const result = await run((redis) => redis.ping());
  return result.ok && !invalidationPending ? 'ok' : 'degraded';
}

function getStats() {
  return { ...stats };
}

async function close() {
  if (client) {
    const current = client;
    client = null;
    await current.quit().catch(() => current.disconnect());
  }
}

/** Test seam: inject a client (or null to disable); undefined restores config. */
function setClientForTests(testClient) {
  injected = testClient;
  invalidationPending = false;
  inflight.clear();
  for (const name of Object.keys(stats)) stats[name] = 0;
}

module.exports = { readThrough, invalidateCatalog, catalogGeneration, status, getStats, close, setClientForTests, NOT_FOUND };
