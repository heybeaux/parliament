/**
 * PAR-34 / M1 T1.2 — Idempotency-Key middleware.
 *
 * Behaviour, in order of precedence:
 *
 *   - No `Idempotency-Key` header → pass-through (idempotency is opt-in).
 *   - Key present, no record (or expired record) → INSERT a fresh
 *     in-flight row (locking out concurrent replays via the unique
 *     `(account_id, key)` PK), run the handler, capture its response, and
 *     write that into the row before returning.
 *   - Key present, complete record, same body → return the cached
 *     response (status + body + key headers) without invoking the handler.
 *   - Key present, in-flight record, same body → poll until the original
 *     completes (or times out), then return its cached response.
 *   - Key present, record exists but body differs → 409 idempotency_conflict.
 *
 * Account scoping:
 *   - When `bearerAuth` has set `authAccountId` on the context, that's the
 *     scope key. OSS pass-through deployments (no auth) fall back to a
 *     constant `'__oss__'` bucket — the AC explicitly limits replays to a
 *     single account, but OSS has only the synthetic account anyway.
 *
 * Crash safety:
 *   - The middleware wraps `await next()` in a `try/finally`. If the
 *     handler throws, the in-flight row is deleted (`abandonRecord`) so a
 *     subsequent retry isn't permanently blocked. This costs us one
 *     bookkeeping write per crashing request, which is the right trade —
 *     the alternative is a stuck in-flight row that wedges replays for 24h.
 *
 * Body capture:
 *   - We read `c.req.text()` BEFORE the handler. Hono caches the body, so
 *     the handler's later `c.req.json()` re-parses from the same cached
 *     text without consuming the request stream.
 *   - The response body is captured by cloning `c.res` after `next()`
 *     returns; we then rebuild a fresh Response (with the same body bytes
 *     and status) so downstream consumers still see an unread body.
 */

import type { Context, MiddlewareHandler } from 'hono';
import type { Database } from '../db.js';
import {
  abandonRecord,
  claimRecord,
  completeRecord,
  computeRequestHash,
  evictExpired,
  getRecord,
  type IdempotencyRecord,
} from '../idempotency.js';
import { AUTH_CTX_ACCOUNT_ID } from './auth.js';

/** OSS pass-through bucket: when no account is attached. */
const OSS_BUCKET = '__oss__';

/** Header key used by the spec. Lower-case for `c.req.header(...)`. */
const HEADER = 'Idempotency-Key';

/** Response headers we replay verbatim alongside the body. */
const REPLAYABLE_HEADERS = ['content-type', 'location'];

/** Polling cadence for the in-flight wait branch. */
const POLL_INTERVAL_MS = 50;
/** Polling timeout — gives up and 409s if the original takes too long. */
const POLL_TIMEOUT_MS = 30_000;

/** Lazy-eviction cadence: sweep at most once every N middleware passes. */
const EVICT_EVERY_N = 256;

export interface IdempotencyMiddlewareOptions {
  /** Override the time source (used in tests for expiry checks). */
  now?: () => number;
  /** Override the TTL for new records, in ms. Defaults to 24h. */
  ttlMs?: number;
  /** Override polling cadence (used in tests). */
  pollIntervalMs?: number;
  /** Override polling timeout (used in tests). */
  pollTimeoutMs?: number;
}

function authError(
  c: Context,
  status: 400 | 409,
  code: string,
  message: string,
): Response {
  return c.json({ error: { code, message } }, status);
}

/**
 * Wire shape of the JSON envelope we cache. Captured response bodies are
 * persisted as raw text so we can replay byte-identically; status and
 * headers are pinned separately.
 */
async function captureResponse(
  res: Response,
): Promise<{ status: number; body: string; headers: Record<string, string> }> {
  // Clone so the original body remains readable for the outer return path.
  const clone = res.clone();
  const body = await clone.text();
  const headers: Record<string, string> = {};
  for (const name of REPLAYABLE_HEADERS) {
    const v = res.headers.get(name);
    if (v !== null) headers[name] = v;
  }
  return { status: res.status, body, headers };
}

/**
 * Rebuild a Response from a stored record. Used to replay both `kind:
 * 'replay'` and the post-poll completion path.
 */
function buildReplayResponse(record: IdempotencyRecord): Response {
  const headers = new Headers();
  if (record.response_headers !== null) {
    try {
      const parsed = JSON.parse(record.response_headers) as Record<string, string>;
      for (const [k, v] of Object.entries(parsed)) headers.set(k, v);
    } catch {
      // Defensive — corrupted header JSON shouldn't take down the replay.
      // We still ship the body and status; downstream just gets no headers.
    }
  }
  // Idempotent-Replayed marker. Useful for client telemetry / debugging.
  headers.set('Idempotent-Replayed', 'true');
  return new Response(record.response_body ?? '', {
    status: record.response_status ?? 200,
    headers,
  });
}

/** Validate the format of an Idempotency-Key. PRD pins UUID; we're permissive
 *  on shape and strict on size (≤255, non-empty after trim) so callers using
 *  ULID/CUID don't trip on a regex they didn't expect. */
function normalizeKey(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 255) return null;
  return trimmed;
}

export function idempotency(
  db: Database.Database,
  options: IdempotencyMiddlewareOptions = {},
): MiddlewareHandler {
  const now = options.now ?? (() => Date.now());
  const ttlMs = options.ttlMs;
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const pollTimeoutMs = options.pollTimeoutMs ?? POLL_TIMEOUT_MS;

  let evictionTickCount = 0;

  async function pollUntilComplete(
    accountId: string,
    key: string,
  ): Promise<IdempotencyRecord | null> {
    const start = now();
    while (now() - start < pollTimeoutMs) {
      await new Promise((r) => setTimeout(r, pollIntervalMs));
      const fresh = getRecord(db, accountId, key, { now });
      if (fresh === null) return null;
      if (fresh.lock_state === 'complete') return fresh;
    }
    return null;
  }

  return async (c, next) => {
    if (c.req.method !== 'POST') {
      await next();
      return;
    }

    const rawKey = c.req.header(HEADER);
    if (rawKey === undefined) {
      await next();
      return;
    }

    const key = normalizeKey(rawKey);
    if (key === null) {
      return authError(
        c,
        400,
        'invalid_request',
        `Idempotency-Key must be a non-empty string up to 255 characters.`,
      );
    }

    // Lazy eviction sweep. Every Nth middleware pass we drop expired rows
    // so the table doesn't grow unbounded under high churn. Keeping it
    // here means OSS deployments without a separate cron still get the
    // benefit; servers with a dedicated cleanup cron can simply run the
    // sweep more aggressively from outside.
    evictionTickCount = (evictionTickCount + 1) % EVICT_EVERY_N;
    if (evictionTickCount === 0) {
      try {
        evictExpired(db, { now });
      } catch {
        // Eviction is best-effort; never let a sweep failure poison the
        // request.
      }
    }

    const accountId =
      (c.get(AUTH_CTX_ACCOUNT_ID) as string | undefined) ?? OSS_BUCKET;

    // Read body BEFORE the handler runs. Hono caches the result so the
    // handler's later `c.req.json()` reads from the same cached text.
    let bodyText: string;
    try {
      bodyText = await c.req.text();
    } catch (err) {
      return authError(
        c,
        400,
        'invalid_request',
        `Failed to read request body: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const requestHash = computeRequestHash(
      c.req.method,
      c.req.path,
      bodyText,
    );

    const claim = claimRecord(
      db,
      {
        accountId,
        key,
        method: c.req.method,
        path: c.req.path,
        requestHash,
      },
      ttlMs !== undefined ? { now, ttlMs } : { now },
    );

    if (claim.kind === 'conflict') {
      c.header('Idempotent-Replayed', 'false');
      return c.json(
        {
          error: {
            code: 'idempotency_conflict',
            message:
              'Idempotency-Key was previously used with a different request body.',
          },
        },
        409,
      );
    }

    if (claim.kind === 'replay') {
      return buildReplayResponse(claim.record);
    }

    if (claim.kind === 'in_flight') {
      const completed = await pollUntilComplete(accountId, key);
      if (completed !== null) {
        return buildReplayResponse(completed);
      }
      // Original handler is still running past the poll timeout. Surface
      // a 409 so the caller can retry rather than leaving them hanging
      // (per AC: "concurrent replays don't double-execute" — we MUST NOT
      // run the handler again here).
      return c.json(
        {
          error: {
            code: 'idempotency_conflict',
            message:
              'Original request for this Idempotency-Key is still in flight after the poll window. Retry shortly.',
          },
        },
        409,
      );
    }

    // 'fresh' — we hold the in-flight lock. Run the handler, capture the
    // response, and persist it. If the handler throws or the response
    // can't be captured, abandon the lock so the caller can retry.
    let captured: { status: number; body: string; headers: Record<string, string> } | null = null;
    try {
      await next();
      if (c.res) {
        captured = await captureResponse(c.res);
        // Replace the live response with a fresh one carrying the same
        // bytes — the captured clone read its body, but `c.res` itself is
        // unread because we only `.clone()`d. So the original Response is
        // still streamable to the client. We do, however, attach the
        // Idempotent-Replayed: false marker so callers can tell first
        // pass from cached.
        const headers = new Headers(c.res.headers);
        headers.set('Idempotent-Replayed', 'false');
        c.res = new Response(captured.body, {
          status: captured.status,
          headers,
        });
      }
    } catch (err) {
      abandonRecord(db, accountId, key);
      throw err;
    }

    if (captured !== null && captured.status < 500) {
      try {
        completeRecord(db, {
          accountId,
          key,
          status: captured.status,
          body: captured.body,
          headers: captured.headers,
        });
      } catch {
        // If we fail to persist the captured response, the in-flight row
        // remains — abandon it so a retry can proceed.
        abandonRecord(db, accountId, key);
      }
    } else {
      // 5xx responses (including Hono's default uncaught-error handler) and
      // missing-response cases must NOT be cached — a transient server error
      // should let the next retry actually re-run the handler. Drop the
      // in-flight row so the client isn't permanently locked into a 500.
      abandonRecord(db, accountId, key);
    }
  };
}
