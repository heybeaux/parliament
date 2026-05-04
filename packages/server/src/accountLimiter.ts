/**
 * PAR-35 / M1 T1.3 — process-local store for account-scoped rate limits.
 *
 * Three independent ledgers live here, one per account:
 *   1. Burst token bucket (anti-abuse, AC: 10 RPS).
 *      Capacity = burstPerSecond, refill = burstPerSecond/sec.
 *   2. Concurrency counter (AC: Pro=1, Team=3*seats in-flight).
 *      Incremented when the request is admitted, decremented in `finally`
 *      so a panicking handler doesn't permanently leak a slot.
 *   3. Envelope counter cache (AC: 350/30d Pro, 2000/30d Team).
 *      The truth source is `SELECT COUNT(*)` against the deliberations
 *      table; we cache it with a short TTL so the rate path doesn't
 *      hammer the primary write table on every check (RedAgent's catch).
 *
 * Why process-local: matches PAR-33's keyThrottle and PAR-34's idempotency
 * precedent. Multi-node coordination is M3+ work. The DB-backed envelope
 * counter still works correctly across instances; only burst + concurrency
 * are per-process. This is documented in {@link accountRateLimit}'s
 * header comment and the README.
 *
 * The {@link EnvelopeCounter} interface lets tests inject a deterministic
 * count without touching the DB, and lets a future Redis backend slot in
 * by swapping the implementation only — the middleware code stays put.
 */

/**
 * Pluggable source-of-truth for the envelope count. The default
 * implementation queries the `deliberations` table; tests inject a stub.
 *
 * `windowStart` is a wall-clock UNIX-ms — the count is `> windowStart`
 * (not `>=`), keeping the boundary half-open and consistent with the
 * filter semantics in PAR-36.
 */
export interface EnvelopeCounter {
  /**
   * Return the number of deliberations the account has consumed since
   * `windowStart`. Implementations MUST be safe to call concurrently
   * for the same account.
   */
  count(accountId: string, windowStart: number): number | Promise<number>;
}

interface BurstBucket {
  /** Tokens currently available. May be fractional during refill math. */
  tokens: number;
  /** Last refill timestamp (UNIX ms). */
  lastRefill: number;
}

interface EnvelopeCache {
  /** Last-known count, scoped to `windowStartMs`. */
  count: number;
  /** Window start the cached count is valid for. */
  windowStartMs: number;
  /** Wall-clock when the count was fetched. */
  fetchedAt: number;
}

interface AccountState {
  burst: BurstBucket | null;
  concurrency: number;
  envelope: EnvelopeCache | null;
}

export interface AccountLimiterOptions {
  /** Source of envelope counts. Default: tests inject; production wires DB. */
  counter: EnvelopeCounter;
  /**
   * Envelope cache TTL in milliseconds. Short (default 5s) so a freshly
   * minted deliberation reflects in the limit check almost immediately
   * while still neutralising the read-on-every-request contention concern.
   */
  envelopeCacheTtlMs?: number;
  /** Override the wall clock — tests pin time to make assertions stable. */
  now?: () => number;
}

export interface AdmissionResult {
  /** True when the request may proceed. */
  ok: boolean;
  /**
   * Reason for refusal. Mirrors the OpenAPI error codes the route layer
   * surfaces. Always present when ok === false; undefined when ok === true.
   */
  reason?: 'rate_limited' | 'usage_limit_exceeded' | 'concurrency_exceeded';
  /** Header values the route layer copies onto the response. */
  headers: AccountLimiterHeaders;
  /**
   * For `rate_limited`, seconds the client should wait before retrying.
   * Always >= 1. Undefined for other reasons.
   */
  retryAfterSeconds?: number;
}

export interface AccountLimiterHeaders {
  /** Echoes the account's tier — clients use this to surface plan info. */
  tier: string;
  /** Envelope ceiling for the period. May be `null` when unlimited. */
  envelopeLimit: number | null;
  /** Envelope remaining after this admission attempt. */
  envelopeRemaining: number | null;
  /** ISO8601 timestamp of when the current period ends. */
  envelopeReset: string;
  /** Concurrency ceiling. May be `null` when unlimited. */
  concurrencyLimit: number | null;
  /** Concurrency in flight after this admission. */
  concurrencyCurrent: number;
}

const DEFAULT_ENVELOPE_TTL_MS = 5_000;

/**
 * Build a fresh limiter. Each call returns a self-contained instance with
 * its own per-account state map — tests get an isolated limiter, the route
 * layer holds a singleton.
 */
export function createAccountLimiter(opts: AccountLimiterOptions) {
  const ttlMs = opts.envelopeCacheTtlMs ?? DEFAULT_ENVELOPE_TTL_MS;
  const clock = opts.now ?? Date.now;
  const states = new Map<string, AccountState>();

  function getState(accountId: string): AccountState {
    let s = states.get(accountId);
    if (s === undefined) {
      s = { burst: null, concurrency: 0, envelope: null };
      states.set(accountId, s);
    }
    return s;
  }

  /**
   * Refill the burst bucket up to capacity using a continuous token-bucket
   * model. We add `(elapsed/1000) * rate` tokens since `lastRefill`. First
   * call lazily initialises a full bucket.
   */
  function refillBurst(state: AccountState, capacity: number, ratePerSecond: number, now: number): void {
    if (state.burst === null) {
      state.burst = { tokens: capacity, lastRefill: now };
      return;
    }
    const elapsedSec = (now - state.burst.lastRefill) / 1000;
    if (elapsedSec <= 0) return;
    state.burst.tokens = Math.min(capacity, state.burst.tokens + elapsedSec * ratePerSecond);
    state.burst.lastRefill = now;
  }

  /**
   * Compute the seconds-until-next-token, used as Retry-After when the
   * burst bucket rejects. `state.burst` is non-null at the call site.
   */
  function secondsToNextToken(state: AccountState, ratePerSecond: number): number {
    const tokens = state.burst === null ? 0 : state.burst.tokens;
    const deficit = Math.max(0, 1 - tokens);
    if (ratePerSecond <= 0) return 1;
    return Math.max(1, Math.ceil(deficit / ratePerSecond));
  }

  async function admit(
    accountId: string,
    policy: import('./tier-limits.js').TierPolicy,
    options: { tier: string; consumesEnvelope: boolean; consumesConcurrency: boolean },
  ): Promise<AdmissionResult> {
    const now = clock();
    const state = getState(accountId);

    // 1) Burst token bucket. Skipped when policy.burstPerSecond === null.
    if (policy.burstPerSecond !== null) {
      refillBurst(state, policy.burstPerSecond, policy.burstPerSecond, now);
      if (state.burst!.tokens < 1) {
        return {
          ok: false,
          reason: 'rate_limited',
          retryAfterSeconds: secondsToNextToken(state, policy.burstPerSecond),
          headers: buildHeaders(options.tier, policy, state, null, now),
        };
      }
    }

    // 2) Envelope. Cache validity is TTL-based; a period rollover is
    //    handled implicitly because periodMs (30 days) is orders of
    //    magnitude larger than ttlMs (5s default), so the cache always
    //    expires before the window shifts meaningfully. We still record
    //    `windowStartMs` on the cache entry for diagnostics + future
    //    multi-window support.
    const windowStart = now - policy.periodMs;
    let envelopeUsed: number | null = null;
    if (policy.envelopeLimit !== null && options.consumesEnvelope) {
      const cached = state.envelope;
      const cacheValid = cached !== null && now - cached.fetchedAt < ttlMs;
      let used: number;
      if (cacheValid) {
        used = cached.count;
      } else {
        used = await opts.counter.count(accountId, windowStart);
        state.envelope = { count: used, windowStartMs: windowStart, fetchedAt: now };
      }
      envelopeUsed = used;
      if (used >= policy.envelopeLimit) {
        return {
          ok: false,
          reason: 'usage_limit_exceeded',
          headers: buildHeaders(options.tier, policy, state, used, now),
        };
      }
    }

    // 3) Concurrency. POST-only callers set `consumesConcurrency: true`;
    //    GETs leave the counter alone but still get headers reflecting it.
    if (
      policy.concurrencyLimit !== null &&
      options.consumesConcurrency &&
      state.concurrency >= policy.concurrencyLimit
    ) {
      return {
        ok: false,
        reason: 'concurrency_exceeded',
        headers: buildHeaders(options.tier, policy, state, envelopeUsed, now),
      };
    }

    // Admission accepted — debit the buckets that this call consumes.
    if (policy.burstPerSecond !== null) {
      state.burst!.tokens -= 1;
    }
    if (options.consumesConcurrency && policy.concurrencyLimit !== null) {
      state.concurrency += 1;
    }
    // Optimistically bump the envelope cache so back-to-back admissions
    // see the new count without waiting for the next DB refresh.
    if (options.consumesEnvelope && policy.envelopeLimit !== null && state.envelope !== null) {
      state.envelope.count += 1;
      envelopeUsed = state.envelope.count;
    }

    return {
      ok: true,
      headers: buildHeaders(options.tier, policy, state, envelopeUsed, now),
    };
  }

  /**
   * Decrement the concurrency counter when an admitted POST completes.
   * Safe to call multiple times — clamped at zero.
   */
  function release(accountId: string): void {
    const state = states.get(accountId);
    if (state === undefined) return;
    state.concurrency = Math.max(0, state.concurrency - 1);
  }

  /**
   * Drop all state. Used by tests; no production caller.
   */
  function reset(): void {
    states.clear();
  }

  /**
   * Read-only snapshot for tests. Returns a defensive copy so mutations
   * don't leak back into the limiter.
   */
  function snapshot(accountId: string): AccountState | null {
    const s = states.get(accountId);
    if (s === undefined) return null;
    return {
      burst: s.burst === null ? null : { ...s.burst },
      concurrency: s.concurrency,
      envelope: s.envelope === null ? null : { ...s.envelope },
    };
  }

  return { admit, release, reset, snapshot };
}

export type AccountLimiter = ReturnType<typeof createAccountLimiter>;

/**
 * SQL-backed envelope counter. Reads `deliberations` filtered by
 * `account_id` + `created_at > windowStart`. The composite index
 * `idx_deliberations_account_created` on `(account_id, created_at DESC,
 * id DESC)` (added in PAR-36) makes this an index-range scan, not a
 * table scan.
 *
 * Note: pre-PAR-36 rows have `account_id IS NULL` and surface under the
 * OSS bucket via the `COALESCE` pattern. We mirror that here so a
 * paying-account self-host install with legacy rows doesn't get its
 * envelope inflated by them.
 */
export function createSqliteEnvelopeCounter(
  db: import('better-sqlite3').Database,
  ossAccountId: string,
): EnvelopeCounter {
  // Lazy-prepare so router construction with a stub `db` (used in the
  // turn-enrichment + integration suites) doesn't crash before the
  // counter is ever called. Cached after first use; reused thereafter.
  let stmt: ReturnType<typeof db.prepare<[string, string, string], { c: number }>> | null = null;
  return {
    count(accountId: string, windowStart: number): number {
      if (stmt === null) {
        stmt = db.prepare<[string, string, string], { c: number }>(
          `SELECT COUNT(*) AS c
             FROM deliberations
            WHERE COALESCE(account_id, ?) = ?
              AND created_at > ?`,
        );
      }
      const iso = new Date(windowStart).toISOString();
      const row = stmt.get(ossAccountId, accountId, iso);
      return row?.c ?? 0;
    },
  };
}

/**
 * Compute the header bundle for an admission result. Pulled out so the
 * three rejection paths and the success path share the same projection.
 *
 * `envelopeUsed` is `null` when the envelope wasn't consulted (unlimited
 * tier or non-POST request); the `Remaining` header then mirrors `Limit`.
 */
function buildHeaders(
  tier: string,
  policy: import('./tier-limits.js').TierPolicy,
  state: AccountState,
  envelopeUsed: number | null,
  now: number,
): AccountLimiterHeaders {
  const envelopeRemaining =
    policy.envelopeLimit === null
      ? null
      : envelopeUsed === null
        ? policy.envelopeLimit
        : Math.max(0, policy.envelopeLimit - envelopeUsed);
  const reset = new Date(now + policy.periodMs).toISOString();
  return {
    tier,
    envelopeLimit: policy.envelopeLimit,
    envelopeRemaining,
    envelopeReset: reset,
    concurrencyLimit: policy.concurrencyLimit,
    concurrencyCurrent: state.concurrency,
  };
}
