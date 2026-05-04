/**
 * PAR-34 / M1 T1.2 — Idempotency-Key persistence helpers.
 *
 * The middleware lives in `middleware/idempotency.ts`; this module owns the
 * SQLite layer it sits on top of. Splitting the two keeps the storage
 * contract independently testable: helper tests pin record-level behaviour
 * (insert, replay, evict, conflict) without spinning up a Hono app.
 *
 * Storage design:
 *   - PRIMARY KEY `(account_id, key)` — replays for the same account+key
 *     race against a single row, and SQLite's atomic INSERT is what gives
 *     us the in-flight lock for free. The first writer wins; concurrent
 *     replays land on the unique-violation branch and poll for completion.
 *   - `request_hash` is a SHA-256 over the canonicalised method + path +
 *     body bytes. The middleware uses it to detect "same key, different
 *     body" → 409. Canonicalisation here is intentionally minimal: we hash
 *     the body BYTES (not parsed JSON) so any change — even whitespace —
 *     counts as "different request." Per PRD this is the desired semantic;
 *     idempotency replay is a "I'm sending the exact same thing again"
 *     contract, not "semantically equivalent."
 *   - `lock_state` toggles `'in_flight'` → `'complete'`. The middleware
 *     never deletes a complete record manually — eviction only happens
 *     once `expires_at` passes (24h default).
 *   - Expired records are treated as logically absent. `recordOrConflict`
 *     overwrites them on next use, and `evictExpired` is a periodic sweep
 *     keeping the table small (called from the middleware on a soft cadence,
 *     and exposed for an eventual nightly cron).
 *
 * What this module is NOT:
 *   - It does not own response capture — the middleware decides what
 *     headers and body bytes to persist.
 *   - It does not enforce TTL via SQLite triggers; we evict in code so we
 *     can keep the timestamp logic consistent with the rest of the server's
 *     ISO-8601 conventions.
 */

import { createHash } from 'node:crypto';
import type { Database } from './db.js';

/**
 * Default Idempotency-Key retention. The PRD pins 24h on the public API;
 * tests pass shorter TTLs to exercise the eviction path quickly.
 */
export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/** Lock states stored in `idempotency_records.lock_state`. */
export type LockState = 'in_flight' | 'complete';

/**
 * Wire shape of a stored idempotency record. Used both by the middleware
 * (to make replay/conflict decisions) and by the route-integration tests.
 */
export interface IdempotencyRecord {
  account_id: string;
  key: string;
  method: string;
  path: string;
  request_hash: string;
  lock_state: LockState;
  response_status: number | null;
  response_body: string | null;
  /** JSON-serialised `Record<string, string>`; null until completion. */
  response_headers: string | null;
  created_at: string;
  expires_at: string;
}

/**
 * Outcome of attempting to claim an in-flight slot for a given
 * `(account_id, key)` tuple. Drives every middleware branch:
 *
 *   - `'fresh'` — caller is the first writer; run the handler, then
 *     persist the response via `completeRecord`.
 *   - `'replay'` — a complete record exists for the same body; return
 *     its captured response without invoking the handler.
 *   - `'conflict'` — a record exists but its `request_hash` differs;
 *     return `409 idempotency_conflict`.
 *   - `'in_flight'` — a record exists, same body, but the original is
 *     still running; the middleware polls until it completes.
 */
export type ClaimOutcome =
  | { kind: 'fresh' }
  | { kind: 'replay'; record: IdempotencyRecord }
  | { kind: 'conflict'; record: IdempotencyRecord }
  | { kind: 'in_flight'; record: IdempotencyRecord };

export interface ClaimOptions {
  /** Override `Date.now()` (used in tests to pin expiry). */
  now?: () => number;
  /** TTL for new records, in ms. Defaults to 24h per PRD. */
  ttlMs?: number;
}

/**
 * Compute the canonical request hash for the conflict-detection check.
 * Hashes method + path + a stable form of the raw body bytes; any
 * difference — including whitespace — counts as "different request."
 *
 * This is intentionally byte-identical-required: the AC says replays must
 * round-trip the EXACT request, not anything semantically equivalent.
 * Callers should pass the body as it arrived on the wire (post-decode but
 * pre-parse).
 */
export function computeRequestHash(
  method: string,
  path: string,
  bodyBytes: string,
): string {
  return createHash('sha256')
    .update(method.toUpperCase())
    .update('\n')
    .update(path)
    .update('\n')
    .update(bodyBytes)
    .digest('hex');
}

function rowToRecord(row: {
  account_id: string;
  key: string;
  method: string;
  path: string;
  request_hash: string;
  lock_state: string;
  response_status: number | null;
  response_body: string | null;
  response_headers: string | null;
  created_at: string;
  expires_at: string;
}): IdempotencyRecord {
  return {
    account_id: row.account_id,
    key: row.key,
    method: row.method,
    path: row.path,
    request_hash: row.request_hash,
    lock_state: row.lock_state as LockState,
    response_status: row.response_status,
    response_body: row.response_body,
    response_headers: row.response_headers,
    created_at: row.created_at,
    expires_at: row.expires_at,
  };
}

interface ClaimInput {
  accountId: string;
  key: string;
  method: string;
  path: string;
  requestHash: string;
}

/**
 * Try to claim an in-flight slot. Returns the right `ClaimOutcome` for the
 * caller to act on:
 *
 *   - If no row exists (or only an expired one) → INSERT a fresh
 *     in-flight record and return `'fresh'`. The caller runs the handler
 *     and finishes by calling `completeRecord`.
 *   - If a complete row exists with the same hash → `'replay'`.
 *   - If a row exists with a different hash → `'conflict'`.
 *   - If a row exists, same hash, still `'in_flight'` → `'in_flight'`
 *     (caller polls).
 *
 * The atomic nature of SQLite's `INSERT … ON CONFLICT DO NOTHING` is what
 * gives us the lock for free: only one concurrent caller's INSERT wins.
 */
export function claimRecord(
  db: Database.Database,
  input: ClaimInput,
  options: ClaimOptions = {},
): ClaimOutcome {
  const now = (options.now ?? Date.now)();
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;

  // Run the read + (conditional) overwrite in a single SQLite txn so we
  // can't race a concurrent claimant past the expiry check.
  const txn = db.transaction((): ClaimOutcome => {
    const existing = db
      .prepare<
        [string, string],
        {
          account_id: string;
          key: string;
          method: string;
          path: string;
          request_hash: string;
          lock_state: string;
          response_status: number | null;
          response_body: string | null;
          response_headers: string | null;
          created_at: string;
          expires_at: string;
        }
      >(
        `SELECT account_id, key, method, path, request_hash, lock_state,
                response_status, response_body, response_headers,
                created_at, expires_at
           FROM idempotency_records
          WHERE account_id = ? AND key = ?`,
      )
      .get(input.accountId, input.key);

    // Helper used by both the "no row" and "expired row" paths to mint a
    // fresh in-flight record. When `overwrite` is true we DELETE the prior
    // (expired) row inline so the INSERT can't collide with it.
    function insertFresh(overwrite: boolean): ClaimOutcome {
      if (overwrite) {
        db.prepare(
          `DELETE FROM idempotency_records WHERE account_id = ? AND key = ?`,
        ).run(input.accountId, input.key);
      }
      const created = new Date(now).toISOString();
      const expires = new Date(now + ttlMs).toISOString();
      db.prepare(
        `INSERT INTO idempotency_records (
           account_id, key, method, path, request_hash, lock_state,
           response_status, response_body, response_headers,
           created_at, expires_at
         ) VALUES (?, ?, ?, ?, ?, 'in_flight', NULL, NULL, NULL, ?, ?)`,
      ).run(
        input.accountId,
        input.key,
        input.method,
        input.path,
        input.requestHash,
        created,
        expires,
      );
      return { kind: 'fresh' };
    }

    if (existing === undefined) {
      return insertFresh(false);
    }

    // Expiry takes precedence over hash matching: an expired record is
    // logically absent, so a different body that happens to land on it is
    // NOT a conflict.
    if (Date.parse(existing.expires_at) <= now) {
      return insertFresh(true);
    }

    const record = rowToRecord(existing);
    if (record.request_hash !== input.requestHash) {
      return { kind: 'conflict', record };
    }
    if (record.lock_state === 'complete') {
      return { kind: 'replay', record };
    }
    return { kind: 'in_flight', record };
  });

  return txn();
}

/**
 * Look up a non-expired record without claiming. Used by the middleware's
 * polling loop to detect when an in-flight record transitions to
 * `'complete'` so we can return the cached response.
 */
export function getRecord(
  db: Database.Database,
  accountId: string,
  key: string,
  options: ClaimOptions = {},
): IdempotencyRecord | null {
  const now = (options.now ?? Date.now)();
  const row = db
    .prepare<
      [string, string],
      {
        account_id: string;
        key: string;
        method: string;
        path: string;
        request_hash: string;
        lock_state: string;
        response_status: number | null;
        response_body: string | null;
        response_headers: string | null;
        created_at: string;
        expires_at: string;
      }
    >(
      `SELECT account_id, key, method, path, request_hash, lock_state,
              response_status, response_body, response_headers,
              created_at, expires_at
         FROM idempotency_records
        WHERE account_id = ? AND key = ?`,
    )
    .get(accountId, key);
  if (row === undefined) return null;
  if (Date.parse(row.expires_at) <= now) return null;
  return rowToRecord(row);
}

export interface CompleteInput {
  accountId: string;
  key: string;
  status: number;
  body: string;
  headers: Record<string, string>;
}

/**
 * Persist the captured response onto an in-flight record, flipping its
 * lock state to `'complete'`. The middleware calls this after the handler
 * returns so future replays can return the cached response.
 *
 * Returns `false` if the row vanished (e.g., manually deleted via test
 * helper), `true` otherwise. The middleware ignores the return value —
 * if our row is gone, the next request just lands as fresh.
 */
export function completeRecord(
  db: Database.Database,
  input: CompleteInput,
): boolean {
  const result = db
    .prepare(
      `UPDATE idempotency_records
          SET lock_state = 'complete',
              response_status = ?,
              response_body = ?,
              response_headers = ?
        WHERE account_id = ? AND key = ?`,
    )
    .run(
      input.status,
      input.body,
      JSON.stringify(input.headers),
      input.accountId,
      input.key,
    );
  return result.changes > 0;
}

/**
 * Drop a stuck in-flight row when the originating handler crashed before
 * completion. Called from the middleware's `try/finally` so a thrown
 * handler doesn't leave a permanent in-flight ghost blocking replays.
 */
export function abandonRecord(
  db: Database.Database,
  accountId: string,
  key: string,
): void {
  db.prepare(
    `DELETE FROM idempotency_records
       WHERE account_id = ? AND key = ? AND lock_state = 'in_flight'`,
  ).run(accountId, key);
}

/**
 * Sweep expired records. Returns the number of rows deleted. Intended for
 * the middleware's lazy "every N requests" sweep AND a future nightly
 * cron — both call sites land here.
 */
export function evictExpired(
  db: Database.Database,
  options: ClaimOptions = {},
): number {
  const now = (options.now ?? Date.now)();
  const stamp = new Date(now).toISOString();
  const result = db
    .prepare(`DELETE FROM idempotency_records WHERE expires_at <= ?`)
    .run(stamp);
  return result.changes;
}

/**
 * Tiny utility for tests: total record count regardless of expiry. Lets
 * tests assert the eviction path actually removed rows rather than just
 * masking them.
 */
export function recordCount(db: Database.Database): number {
  try {
    const row = db
      .prepare<[], { c: number }>(
        `SELECT COUNT(*) AS c FROM idempotency_records`,
      )
      .get();
    return row?.c ?? 0;
  } catch {
    return 0;
  }
}
