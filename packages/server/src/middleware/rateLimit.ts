/**
 * Per-IP in-memory rate limiter for /deliberate.
 *
 * Two ceilings are enforced simultaneously:
 *   - `concurrent`: a request is rejected with 429 if the same IP already
 *     has `concurrent` deliberations in flight. Default 1 (matches the
 *     inline-blocking implementation: one user, one debate at a time).
 *   - `perHour`:    a sliding-window counter of completed/started attempts
 *     in the last 60 minutes. Default 10/hour.
 *
 * State is process-local (no Redis). On process restart all counters reset;
 * this is acceptable for a localhost-first server. Buckets for IPs that
 * have been silent for >1h are pruned lazily on each access.
 *
 * Client IP resolution: prefers Hono's `c.env`/`c.req` socket info via the
 * provided `ipFn` callback, with a literal `unknown` bucket as last resort.
 */

import type { MiddlewareHandler } from 'hono';

interface Bucket {
  inFlight: number;
  /** Unix-ms timestamps of attempts within the rolling window. */
  attempts: number[];
}

export interface RateLimitOptions {
  concurrent: number;
  perHour: number;
  /** Override the IP extraction (used in tests). */
  ipFn?: (c: Parameters<MiddlewareHandler>[0]) => string;
}

const WINDOW_MS = 60 * 60 * 1000;

function defaultIpFn(c: Parameters<MiddlewareHandler>[0]): string {
  // Hono on @hono/node-server exposes `remoteAddr` via `c.env`. Fall back
  // to the `X-Forwarded-For` header's first hop, then to a constant bucket
  // (so a misconfigured deploy still gets rate-limited globally).
  const env = c.env as { remoteAddr?: { address?: string } } | undefined;
  if (env?.remoteAddr?.address) return env.remoteAddr.address;
  const xff = c.req.header('X-Forwarded-For');
  if (xff) return xff.split(',')[0].trim();
  return 'unknown';
}

export function rateLimit(opts: RateLimitOptions): MiddlewareHandler {
  const buckets = new Map<string, Bucket>();
  const ipFn = opts.ipFn ?? defaultIpFn;

  function getBucket(ip: string, now: number): Bucket {
    let b = buckets.get(ip);
    if (!b) {
      b = { inFlight: 0, attempts: [] };
      buckets.set(ip, b);
    }
    // Trim attempts outside the rolling window.
    const cutoff = now - WINDOW_MS;
    while (b.attempts.length > 0 && b.attempts[0] < cutoff) {
      b.attempts.shift();
    }
    return b;
  }

  function pruneIdle(now: number): void {
    // Periodic light cleanup to keep the map bounded.
    if (buckets.size < 1024) return;
    for (const [ip, b] of buckets) {
      if (b.inFlight === 0 && b.attempts.length === 0) {
        buckets.delete(ip);
      } else if (b.inFlight === 0 && b.attempts[b.attempts.length - 1] < now - WINDOW_MS) {
        buckets.delete(ip);
      }
    }
  }

  return async (c, next) => {
    const now = Date.now();
    const ip = ipFn(c);
    const bucket = getBucket(ip, now);

    if (bucket.inFlight >= opts.concurrent) {
      return c.json(
        { error: 'Rate limit exceeded: concurrent request already in flight for this client.' },
        429,
      );
    }
    if (bucket.attempts.length >= opts.perHour) {
      const retryAfterMs = WINDOW_MS - (now - bucket.attempts[0]);
      c.header('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
      return c.json(
        { error: `Rate limit exceeded: ${opts.perHour} requests/hour per client.` },
        429,
      );
    }

    bucket.inFlight += 1;
    bucket.attempts.push(now);
    try {
      await next();
    } finally {
      bucket.inFlight = Math.max(0, bucket.inFlight - 1);
      pruneIdle(now);
    }
  };
}
