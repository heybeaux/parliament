/**
 * PAR-35 / M1 T1.3 — helper-level coverage for the account rate-limit
 * primitives.
 *
 * Pins the contracts the middleware relies on:
 *   - `resolveTierPolicy` honours the static table, multiplies Team values
 *     by seat count, falls back to `free` for unknown tiers (fail-closed
 *     against bad data rows).
 *   - `isUnlimitedPolicy` short-circuits header bookkeeping for oss /
 *     enterprise.
 *   - `createAccountLimiter` token bucket: continuous refill, exhaustion,
 *     retry-after computation rounds up.
 *   - Envelope cache: TTL invalidates, window-rollover invalidates, the
 *     optimistic +1 bump on admit avoids re-querying for back-to-back POSTs.
 *   - Concurrency counter: incr on admit, `release()` decrements safely
 *     (clamped at 0 even with extra calls).
 *   - Fail behaviour: counter exceptions propagate from `admit()` so the
 *     middleware can decide fail-open vs fail-closed.
 *
 * Tests pass a deterministic clock and an in-memory counter stub — no DB,
 * no setTimeout — so the suite is fast and stable.
 */

import { describe, it, expect } from 'vitest';
import {
  createAccountLimiter,
  type EnvelopeCounter,
} from '../accountLimiter.js';
import {
  isUnlimitedPolicy,
  resolveTierPolicy,
  type TierPolicy,
} from '../tier-limits.js';

function fixedClock(start: number): { now: () => number; advance: (delta: number) => void } {
  let t = start;
  return {
    now: () => t,
    advance: (delta: number) => {
      t += delta;
    },
  };
}

function stubCounter(initial = 0): EnvelopeCounter & { calls: number; setCount: (n: number) => void } {
  let count = initial;
  let calls = 0;
  return {
    count() {
      calls += 1;
      return count;
    },
    setCount(n: number) {
      count = n;
    },
    get calls() {
      return calls;
    },
  };
}

const PRO: TierPolicy = {
  envelopeLimit: 350,
  concurrencyLimit: 1,
  burstPerSecond: 10,
  periodMs: 30 * 24 * 60 * 60 * 1000,
};

describe('resolveTierPolicy', () => {
  it('returns the canned oss policy with all ceilings null', () => {
    const p = resolveTierPolicy('oss');
    expect(p.envelopeLimit).toBeNull();
    expect(p.concurrencyLimit).toBeNull();
    expect(p.burstPerSecond).toBeNull();
  });

  it('returns the canned pro policy unchanged regardless of seats', () => {
    const a = resolveTierPolicy('pro');
    const b = resolveTierPolicy('pro', 5);
    expect(a).toEqual(b);
    expect(a.envelopeLimit).toBe(350);
    expect(a.concurrencyLimit).toBe(1);
    expect(a.burstPerSecond).toBe(10);
  });

  it('multiplies team envelope and concurrency by seat count', () => {
    const p = resolveTierPolicy('team', 4);
    expect(p.envelopeLimit).toBe(2000 * 4);
    expect(p.concurrencyLimit).toBe(3 * 4);
    // Burst per-second is NOT seat-multiplied — anti-abuse ceiling is global.
    expect(p.burstPerSecond).toBe(10);
  });

  it('clamps team seats to at least 1 when caller passes 0 or negative', () => {
    const p = resolveTierPolicy('team', 0);
    expect(p.envelopeLimit).toBe(2000);
    expect(p.concurrencyLimit).toBe(3);
  });

  it('falls back to the free policy for unknown tier strings (fail-closed)', () => {
    const p = resolveTierPolicy('platinum-mega-deluxe');
    expect(p.envelopeLimit).toBe(25);
    expect(p.concurrencyLimit).toBe(1);
    expect(p.burstPerSecond).toBe(10);
  });

  it('returns enterprise as unlimited', () => {
    const p = resolveTierPolicy('enterprise');
    expect(p.envelopeLimit).toBeNull();
    expect(p.concurrencyLimit).toBeNull();
    expect(p.burstPerSecond).toBeNull();
  });
});

describe('isUnlimitedPolicy', () => {
  it('is true when all three ceilings are null', () => {
    expect(isUnlimitedPolicy(resolveTierPolicy('oss'))).toBe(true);
    expect(isUnlimitedPolicy(resolveTierPolicy('enterprise'))).toBe(true);
  });

  it('is false when any ceiling is set', () => {
    expect(isUnlimitedPolicy(resolveTierPolicy('pro'))).toBe(false);
    expect(isUnlimitedPolicy(resolveTierPolicy('team', 2))).toBe(false);
    expect(isUnlimitedPolicy(resolveTierPolicy('free'))).toBe(false);
  });
});

describe('createAccountLimiter — burst token bucket', () => {
  it('admits up to capacity in the same instant, then rejects', async () => {
    const clock = fixedClock(1_700_000_000_000);
    const counter = stubCounter(0);
    const limiter = createAccountLimiter({ counter, now: clock.now });

    // Pro = 10 RPS, so 10 admissions in the same tick should pass.
    for (let i = 0; i < 10; i += 1) {
      const r = await limiter.admit('acct1', PRO, {
        tier: 'pro',
        consumesEnvelope: false,
        consumesConcurrency: false,
      });
      expect(r.ok).toBe(true);
    }
    const eleventh = await limiter.admit('acct1', PRO, {
      tier: 'pro',
      consumesEnvelope: false,
      consumesConcurrency: false,
    });
    expect(eleventh.ok).toBe(false);
    expect(eleventh.reason).toBe('rate_limited');
    expect(eleventh.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it('refills tokens continuously over elapsed time', async () => {
    const clock = fixedClock(1_700_000_000_000);
    const counter = stubCounter(0);
    const limiter = createAccountLimiter({ counter, now: clock.now });

    // Burn the bucket.
    for (let i = 0; i < 10; i += 1) {
      await limiter.admit('acct1', PRO, {
        tier: 'pro',
        consumesEnvelope: false,
        consumesConcurrency: false,
      });
    }
    // 200ms later → 2 tokens (10 RPS * 0.2s).
    clock.advance(200);
    const r1 = await limiter.admit('acct1', PRO, {
      tier: 'pro',
      consumesEnvelope: false,
      consumesConcurrency: false,
    });
    const r2 = await limiter.admit('acct1', PRO, {
      tier: 'pro',
      consumesEnvelope: false,
      consumesConcurrency: false,
    });
    const r3 = await limiter.admit('acct1', PRO, {
      tier: 'pro',
      consumesEnvelope: false,
      consumesConcurrency: false,
    });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r3.ok).toBe(false);
    expect(r3.reason).toBe('rate_limited');
  });

  it('reports retry-after of at least 1 second even when partial token is close', async () => {
    const clock = fixedClock(1_700_000_000_000);
    const counter = stubCounter(0);
    const limiter = createAccountLimiter({ counter, now: clock.now });

    for (let i = 0; i < 10; i += 1) {
      await limiter.admit('acct1', PRO, {
        tier: 'pro',
        consumesEnvelope: false,
        consumesConcurrency: false,
      });
    }
    // 50ms later → 0.5 tokens, deficit 0.5, ceil(0.5/10) = 1.
    clock.advance(50);
    const r = await limiter.admit('acct1', PRO, {
      tier: 'pro',
      consumesEnvelope: false,
      consumesConcurrency: false,
    });
    expect(r.ok).toBe(false);
    expect(r.retryAfterSeconds).toBe(1);
  });

  it('skips burst entirely when policy.burstPerSecond is null', async () => {
    const counter = stubCounter(0);
    const limiter = createAccountLimiter({ counter });
    const unlimited: TierPolicy = {
      envelopeLimit: null,
      concurrencyLimit: null,
      burstPerSecond: null,
      periodMs: 30 * 24 * 60 * 60 * 1000,
    };
    // 1000 admits in the same tick — none should ever be throttled.
    for (let i = 0; i < 1000; i += 1) {
      const r = await limiter.admit('acct1', unlimited, {
        tier: 'oss',
        consumesEnvelope: false,
        consumesConcurrency: false,
      });
      expect(r.ok).toBe(true);
    }
  });

  it('keeps burst buckets isolated across accounts', async () => {
    const clock = fixedClock(1_700_000_000_000);
    const counter = stubCounter(0);
    const limiter = createAccountLimiter({ counter, now: clock.now });

    for (let i = 0; i < 10; i += 1) {
      await limiter.admit('acct1', PRO, {
        tier: 'pro',
        consumesEnvelope: false,
        consumesConcurrency: false,
      });
    }
    // acct1 is exhausted; acct2 still has a fresh bucket.
    const blocked = await limiter.admit('acct1', PRO, {
      tier: 'pro',
      consumesEnvelope: false,
      consumesConcurrency: false,
    });
    const fresh = await limiter.admit('acct2', PRO, {
      tier: 'pro',
      consumesEnvelope: false,
      consumesConcurrency: false,
    });
    expect(blocked.ok).toBe(false);
    expect(fresh.ok).toBe(true);
  });
});

describe('createAccountLimiter — envelope counter', () => {
  it('rejects with usage_limit_exceeded when count >= limit', async () => {
    const counter = stubCounter(350); // Pro limit hit.
    const limiter = createAccountLimiter({ counter });
    const r = await limiter.admit('acct1', PRO, {
      tier: 'pro',
      consumesEnvelope: true,
      consumesConcurrency: false,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('usage_limit_exceeded');
    expect(r.headers.envelopeLimit).toBe(350);
    expect(r.headers.envelopeRemaining).toBe(0);
  });

  it('serves the cached count within TTL without re-querying', async () => {
    const clock = fixedClock(1_700_000_000_000);
    const counter = stubCounter(10);
    const limiter = createAccountLimiter({
      counter,
      now: clock.now,
      envelopeCacheTtlMs: 5_000,
    });
    await limiter.admit('acct1', PRO, {
      tier: 'pro',
      consumesEnvelope: true,
      consumesConcurrency: false,
    });
    // Even if the underlying source jumped, we keep serving cached + bumped.
    counter.setCount(999);
    clock.advance(1_000);
    const r = await limiter.admit('acct1', PRO, {
      tier: 'pro',
      consumesEnvelope: true,
      consumesConcurrency: false,
    });
    expect(counter.calls).toBe(1);
    expect(r.ok).toBe(true);
    // Optimistic bumps: original 10, then +1, +1.
    expect(r.headers.envelopeRemaining).toBe(350 - 12);
  });

  it('refreshes the count after TTL expires', async () => {
    const clock = fixedClock(1_700_000_000_000);
    const counter = stubCounter(10);
    const limiter = createAccountLimiter({
      counter,
      now: clock.now,
      envelopeCacheTtlMs: 5_000,
    });
    await limiter.admit('acct1', PRO, {
      tier: 'pro',
      consumesEnvelope: true,
      consumesConcurrency: false,
    });
    counter.setCount(50);
    clock.advance(6_000);
    const r = await limiter.admit('acct1', PRO, {
      tier: 'pro',
      consumesEnvelope: true,
      consumesConcurrency: false,
    });
    expect(counter.calls).toBe(2);
    expect(r.ok).toBe(true);
    expect(r.headers.envelopeRemaining).toBe(350 - 51); // 50 + 1 bump.
  });

  it('invalidates the cache when the period rolls over (window-start changes)', async () => {
    const clock = fixedClock(1_700_000_000_000);
    const counter = stubCounter(10);
    const limiter = createAccountLimiter({
      counter,
      now: clock.now,
      envelopeCacheTtlMs: 60 * 60 * 1000, // long TTL
    });
    await limiter.admit('acct1', PRO, {
      tier: 'pro',
      consumesEnvelope: true,
      consumesConcurrency: false,
    });
    // Advance past the 30-day window — windowStart shifts, cache is stale.
    clock.advance(31 * 24 * 60 * 60 * 1000);
    counter.setCount(0);
    const r = await limiter.admit('acct1', PRO, {
      tier: 'pro',
      consumesEnvelope: true,
      consumesConcurrency: false,
    });
    expect(counter.calls).toBe(2);
    expect(r.headers.envelopeRemaining).toBe(350 - 1); // 0 fresh + 1 bump.
  });

  it('skips envelope checks when consumesEnvelope is false (GET path)', async () => {
    const counter = stubCounter(350);
    const limiter = createAccountLimiter({ counter });
    const r = await limiter.admit('acct1', PRO, {
      tier: 'pro',
      consumesEnvelope: false,
      consumesConcurrency: false,
    });
    expect(r.ok).toBe(true);
    // Header still echoes the limit so clients see plan state on GETs.
    expect(r.headers.envelopeLimit).toBe(350);
    // No DB call when GETs flow through.
    expect(counter.calls).toBe(0);
  });

  it('propagates counter errors so the middleware can fail-open or 503', async () => {
    const counter: EnvelopeCounter = {
      count() {
        throw new Error('db is down');
      },
    };
    const limiter = createAccountLimiter({ counter });
    await expect(
      limiter.admit('acct1', PRO, {
        tier: 'pro',
        consumesEnvelope: true,
        consumesConcurrency: false,
      }),
    ).rejects.toThrow('db is down');
  });
});

describe('createAccountLimiter — concurrency', () => {
  it('rejects with concurrency_exceeded once the in-flight cap is hit', async () => {
    const counter = stubCounter(0);
    const limiter = createAccountLimiter({ counter });
    const first = await limiter.admit('acct1', PRO, {
      tier: 'pro',
      consumesEnvelope: false,
      consumesConcurrency: true,
    });
    const second = await limiter.admit('acct1', PRO, {
      tier: 'pro',
      consumesEnvelope: false,
      consumesConcurrency: true,
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(second.reason).toBe('concurrency_exceeded');
    expect(second.headers.concurrencyCurrent).toBe(1);
  });

  it('release() drops the counter so a new admission can proceed', async () => {
    const counter = stubCounter(0);
    const limiter = createAccountLimiter({ counter });
    await limiter.admit('acct1', PRO, {
      tier: 'pro',
      consumesEnvelope: false,
      consumesConcurrency: true,
    });
    limiter.release('acct1');
    const next = await limiter.admit('acct1', PRO, {
      tier: 'pro',
      consumesEnvelope: false,
      consumesConcurrency: true,
    });
    expect(next.ok).toBe(true);
  });

  it('release() clamps at zero — extra calls do not underflow', async () => {
    const counter = stubCounter(0);
    const limiter = createAccountLimiter({ counter });
    limiter.release('acct1');
    limiter.release('acct1');
    limiter.release('acct1');
    const r = await limiter.admit('acct1', PRO, {
      tier: 'pro',
      consumesEnvelope: false,
      consumesConcurrency: true,
    });
    expect(r.ok).toBe(true);
    expect(r.headers.concurrencyCurrent).toBe(1);
  });

  it('does not increment when consumesConcurrency is false', async () => {
    const counter = stubCounter(0);
    const limiter = createAccountLimiter({ counter });
    for (let i = 0; i < 5; i += 1) {
      const r = await limiter.admit('acct1', PRO, {
        tier: 'pro',
        consumesEnvelope: false,
        consumesConcurrency: false,
      });
      expect(r.ok).toBe(true);
    }
    const snap = limiter.snapshot('acct1');
    expect(snap?.concurrency).toBe(0);
  });
});

describe('createAccountLimiter — header projection', () => {
  it('produces null limits and full headers for unlimited policy callers', async () => {
    const counter = stubCounter(0);
    const limiter = createAccountLimiter({ counter });
    const unlimited: TierPolicy = {
      envelopeLimit: null,
      concurrencyLimit: null,
      burstPerSecond: null,
      periodMs: 30 * 24 * 60 * 60 * 1000,
    };
    const r = await limiter.admit('acct1', unlimited, {
      tier: 'enterprise',
      consumesEnvelope: false,
      consumesConcurrency: false,
    });
    expect(r.ok).toBe(true);
    expect(r.headers.tier).toBe('enterprise');
    expect(r.headers.envelopeLimit).toBeNull();
    expect(r.headers.envelopeRemaining).toBeNull();
    expect(r.headers.concurrencyLimit).toBeNull();
    expect(typeof r.headers.envelopeReset).toBe('string');
  });

  it('reset header is an ISO8601 string in the future', async () => {
    const clock = fixedClock(1_700_000_000_000);
    const counter = stubCounter(0);
    const limiter = createAccountLimiter({ counter, now: clock.now });
    const r = await limiter.admit('acct1', PRO, {
      tier: 'pro',
      consumesEnvelope: true,
      consumesConcurrency: false,
    });
    const t = Date.parse(r.headers.envelopeReset);
    expect(Number.isNaN(t)).toBe(false);
    expect(t).toBe(1_700_000_000_000 + PRO.periodMs);
  });
});

describe('createAccountLimiter — reset / snapshot', () => {
  it('reset() clears all per-account state', async () => {
    const counter = stubCounter(0);
    const limiter = createAccountLimiter({ counter });
    await limiter.admit('acct1', PRO, {
      tier: 'pro',
      consumesEnvelope: true,
      consumesConcurrency: true,
    });
    expect(limiter.snapshot('acct1')).not.toBeNull();
    limiter.reset();
    expect(limiter.snapshot('acct1')).toBeNull();
  });

  it('snapshot returns a defensive copy', async () => {
    const counter = stubCounter(0);
    const limiter = createAccountLimiter({ counter });
    await limiter.admit('acct1', PRO, {
      tier: 'pro',
      consumesEnvelope: false,
      consumesConcurrency: true,
    });
    const snap = limiter.snapshot('acct1');
    expect(snap).not.toBeNull();
    snap!.concurrency = 999;
    const again = limiter.snapshot('acct1');
    expect(again?.concurrency).toBe(1);
  });
});
