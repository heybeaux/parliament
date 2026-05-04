/**
 * PAR-33 / M1 T1.1 — per-key throttle for test keys.
 *
 * Test keys (`pk_test_…`) are throttled to 10 requests/minute per key,
 * surfaced as `429 rate_limited` with `Retry-After`. Live keys bypass
 * this middleware entirely — they're metered by the usage envelope
 * (T1.3) and the per-IP limiter, not by a per-key clock.
 *
 * State is process-local (no Redis); on restart all counters reset. This
 * matches the `rateLimit` sibling's design and is acceptable for a
 * single-node deploy. Sharded deploys (M3+) replace this module.
 */

import type { MiddlewareHandler } from 'hono';
import { AUTH_CTX_KEY_ID, AUTH_CTX_KEY_TYPE } from './auth.js';

const WINDOW_MS = 60 * 1000;

interface KeyBucket {
  /** Unix-ms timestamps of attempts within the rolling 60s window. */
  attempts: number[];
}

export interface TestKeyThrottleOptions {
  /** Per-key request ceiling per rolling minute. Default 10 (per AC). */
  perMinute?: number;
}

/**
 * Build the throttle middleware. The middleware is a no-op when the
 * authenticated key is `live` (or absent — pass-through OSS deployments).
 */
export function testKeyThrottle(
  options: TestKeyThrottleOptions = {},
): MiddlewareHandler {
  const perMinute = options.perMinute ?? 10;
  const buckets = new Map<string, KeyBucket>();

  function getBucket(keyId: string, now: number): KeyBucket {
    let b = buckets.get(keyId);
    if (b === undefined) {
      b = { attempts: [] };
      buckets.set(keyId, b);
    }
    const cutoff = now - WINDOW_MS;
    while (b.attempts.length > 0 && b.attempts[0] < cutoff) {
      b.attempts.shift();
    }
    return b;
  }

  return async (c, next) => {
    const keyType = c.get(AUTH_CTX_KEY_TYPE) as 'test' | 'live' | undefined;
    if (keyType !== 'test') {
      await next();
      return;
    }
    const keyId = c.get(AUTH_CTX_KEY_ID) as string | undefined;
    if (keyId === undefined) {
      // Defense-in-depth: if the auth middleware passed through without
      // setting key_id we have a wiring bug; do not throttle (no key to
      // bucket against), just continue.
      await next();
      return;
    }

    const now = Date.now();
    const bucket = getBucket(keyId, now);
    if (bucket.attempts.length >= perMinute) {
      const retryAfterMs = WINDOW_MS - (now - bucket.attempts[0]);
      c.header('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
      return c.json(
        {
          error: {
            code: 'rate_limited',
            message: `Test key throttled at ${perMinute} requests/minute.`,
          },
        },
        429,
      );
    }
    bucket.attempts.push(now);
    await next();
  };
}
