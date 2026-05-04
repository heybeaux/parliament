/**
 * PAR-35 / M1 T1.3 — account-scoped, tier-aware rate-limit middleware.
 *
 * Enforces three orthogonal ceilings, in this order:
 *   1. Burst (10 RPS, AC). Cheapest check, fails fast.
 *   2. Envelope (350/30d Pro, 2000/30d/seat Team). Cached count.
 *   3. Concurrency (1 in-flight Pro, 3/seat Team). POST-only.
 *
 * Emits all six `X-RateLimit-*` headers per the OpenAPI spec on every
 * authenticated response — including 4xx/5xx — so clients always see
 * their plan state. 429s carry `Retry-After`. 409 is reserved for
 * `concurrency_exceeded` per `#/components/responses/Conflict`.
 *
 * Bypass rules (preserves earlier ticket guarantees):
 *   - No `authAccountId` on context → OSS pass-through. Empty `api_keys`
 *     table means PAR-33's bearerAuth never set the var; we mirror its
 *     no-op stance.
 *   - `authKeyType === 'test'` → bypass entirely. AC: test keys are
 *     metered by PAR-33's `keyThrottle` (10/min, separate budget) and
 *     do NOT consume the live envelope.
 *   - Tier policy is unlimited (oss / enterprise default) → header
 *     bookkeeping only, no enforcement.
 *
 * Process-local scope. Concurrency and burst counters reset on restart;
 * envelope is DB-backed and survives. Documented in the README and
 * tracked separately for the M3 multi-node milestone.
 *
 * Failure mode: if the envelope counter throws (DB outage, bug), we
 * fail-open (admit, log a structured warning) per the AC. An operator
 * can flip `failClosed: true` in opts for enterprise deployments where
 * over-serving is worse than under-serving.
 */

import type { MiddlewareHandler } from 'hono';
import {
  AUTH_CTX_ACCOUNT_ID,
  AUTH_CTX_KEY_TYPE,
} from './auth.js';
import {
  createAccountLimiter,
  type AccountLimiter,
  type AccountLimiterHeaders,
  type EnvelopeCounter,
} from '../accountLimiter.js';
import { resolveTierPolicy, isUnlimitedPolicy, type TierPolicy } from '../tier-limits.js';

export interface AccountRateLimitOptions {
  /** Source of envelope counts. Production: `createSqliteEnvelopeCounter(db)`. */
  counter: EnvelopeCounter;
  /**
   * Resolve the tier (and seat count, for Team) for an account. The
   * default reads from the `accounts` table, but tests inject a stub so
   * they don't have to provision real rows.
   */
  resolveAccount: (accountId: string) => { tier: string; seats?: number } | null;
  /**
   * Opt-in fail-closed mode for enterprise. Default: fail-open with a
   * structured `console.warn` so a DB blip can't take the API down.
   */
  failClosed?: boolean;
  /** Override the wall clock — tests pin time for deterministic burst math. */
  now?: () => number;
  /** Test-only — drives the limiter's internal clock. */
  envelopeCacheTtlMs?: number;
  /** Hook for tests / external observability to capture limiter rejections. */
  onLimited?: (kind: 'rate_limited' | 'usage_limit_exceeded' | 'concurrency_exceeded', accountId: string) => void;
}

/**
 * Context flag a long-running POST handler sets to opt out of the
 * middleware's automatic concurrency release. /deliberate uses this:
 * the request returns 202 immediately, but the engine keeps running, so
 * the route releases manually after `markCompleted`/`markFailed` instead.
 */
export const DEFER_CONCURRENCY_RELEASE = 'rateLimitDeferRelease';

/** Header keys mirror the canonical capitalisation in the OpenAPI spec. */
const H = {
  TIER: 'X-RateLimit-Tier',
  LIMIT: 'X-RateLimit-Limit',
  REMAINING: 'X-RateLimit-Remaining',
  RESET: 'X-RateLimit-Reset',
  CONC_LIMIT: 'X-RateLimit-Concurrency-Limit',
  CONC_CURRENT: 'X-RateLimit-Concurrency-Current',
  RETRY_AFTER: 'Retry-After',
} as const;

export interface AccountRateLimitHandle {
  middleware: MiddlewareHandler;
  /** For tests + admin tooling. */
  limiter: AccountLimiter;
}

export function accountRateLimit(opts: AccountRateLimitOptions): AccountRateLimitHandle {
  const limiter = createAccountLimiter({
    counter: opts.counter,
    envelopeCacheTtlMs: opts.envelopeCacheTtlMs,
    now: opts.now,
  });

  const middleware: MiddlewareHandler = async (c, next) => {
    const accountId = c.get(AUTH_CTX_ACCOUNT_ID) as string | undefined;
    if (accountId === undefined) {
      // OSS pass-through (empty api_keys) — bearerAuth never set the var.
      await next();
      return;
    }
    const keyType = c.get(AUTH_CTX_KEY_TYPE) as 'test' | 'live' | undefined;
    if (keyType === 'test') {
      // Test keys are metered by keyThrottle and bypass the envelope per AC.
      await next();
      return;
    }

    const account = opts.resolveAccount(accountId);
    if (account === null) {
      // No account row — defensive, shouldn't happen since bearerAuth FKs to
      // accounts. Fail-open with a marker tier so headers stay parseable.
      console.warn('[rate-limit] no account row for', accountId);
      await next();
      return;
    }

    const policy = resolveTierPolicy(account.tier, account.seats ?? 1);

    // Unlimited policy — emit headers but don't admit/release.
    if (isUnlimitedPolicy(policy)) {
      writeHeaders(c, headersForUnlimited(account.tier));
      await next();
      return;
    }

    const isPost = c.req.method === 'POST';
    let admission;
    try {
      admission = await limiter.admit(accountId, policy, {
        tier: account.tier,
        // Concurrency + envelope only count POSTs that kick off real work.
        // GETs (list, status, presets) get headers but don't decrement.
        consumesEnvelope: isPost,
        consumesConcurrency: isPost,
      });
    } catch (err) {
      // Fail-open by default (AC). Surface the bug via console.warn so
      // it shows up in container logs / Datadog without breaking traffic.
      console.warn('[rate-limit] limiter error, failing open:', err);
      if (opts.failClosed === true) {
        return c.json(
          buildError('service_unavailable', 'Rate limiter unavailable; retry shortly.'),
          503,
        );
      }
      await next();
      return;
    }

    writeHeaders(c, admission.headers);

    if (!admission.ok) {
      opts.onLimited?.(admission.reason!, accountId);
      return rejectionResponse(c, admission, policy);
    }

    try {
      await next();
    } finally {
      // Long-running fire-and-forget routes (e.g. /deliberate) flip
      // this flag so the engine — not the HTTP cycle — owns the release.
      const deferred = c.get(DEFER_CONCURRENCY_RELEASE) === true;
      if (isPost && policy.concurrencyLimit !== null && !deferred) {
        limiter.release(accountId);
      }
    }
  };

  return { middleware, limiter };
}

function writeHeaders(c: Parameters<MiddlewareHandler>[0], h: AccountLimiterHeaders): void {
  c.header(H.TIER, h.tier);
  if (h.envelopeLimit !== null) {
    c.header(H.LIMIT, String(h.envelopeLimit));
  }
  if (h.envelopeRemaining !== null) {
    c.header(H.REMAINING, String(h.envelopeRemaining));
  }
  c.header(H.RESET, h.envelopeReset);
  if (h.concurrencyLimit !== null) {
    c.header(H.CONC_LIMIT, String(h.concurrencyLimit));
  }
  c.header(H.CONC_CURRENT, String(h.concurrencyCurrent));
}

function headersForUnlimited(tier: string): AccountLimiterHeaders {
  return {
    tier,
    envelopeLimit: null,
    envelopeRemaining: null,
    envelopeReset: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    concurrencyLimit: null,
    concurrencyCurrent: 0,
  };
}

function rejectionResponse(
  c: Parameters<MiddlewareHandler>[0],
  admission: import('../accountLimiter.js').AdmissionResult,
  policy: TierPolicy,
): Response {
  const reason = admission.reason!;
  if (reason === 'concurrency_exceeded') {
    return c.json(
      buildError(
        'concurrency_exceeded',
        `Account is at concurrency limit (${policy.concurrencyLimit}) for tier \`${admission.headers.tier}\`.`,
      ),
      409,
    );
  }
  if (reason === 'usage_limit_exceeded') {
    return c.json(
      buildError(
        'usage_limit_exceeded',
        `Account has used ${policy.envelopeLimit} of ${policy.envelopeLimit} deliberations this period.`,
      ),
      429,
    );
  }
  // rate_limited — burst exhaustion.
  c.header(H.RETRY_AFTER, String(admission.retryAfterSeconds ?? 1));
  return c.json(
    buildError('rate_limited', `Too many requests; retry after ${admission.retryAfterSeconds ?? 1}s.`),
    429,
  );
}

function buildError(code: string, message: string): Record<string, unknown> {
  return { error: { code, message } };
}
