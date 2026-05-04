/**
 * PAR-34 / M1 T1.2 — helper-level coverage for the idempotency module.
 *
 * Pins the storage contract the middleware relies on:
 *   - `claimRecord` is the lock primitive: first claim wins (`'fresh'`),
 *     concurrent claims see `'in_flight'` or `'replay'` based on the
 *     completion state.
 *   - Same key + different request hash → `'conflict'`.
 *   - Expired records are logically absent — `claimRecord` overwrites them
 *     with the fresh request, no matter what the prior body was.
 *   - `completeRecord` flips lock state and persists status + body + headers.
 *   - `abandonRecord` removes only in-flight rows (so a crashed handler
 *     can be retried) but never wipes a completed record.
 *   - `evictExpired` reports row deletes; non-expired rows survive.
 *   - `computeRequestHash` is byte-sensitive: any change in body bytes
 *     (including whitespace) flips the hash.
 *
 * Tests pass deterministic clocks so we can exercise expiry without
 * sleeping the suite for hours.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { initDb } from '../db.js';
import {
  abandonRecord,
  claimRecord,
  completeRecord,
  computeRequestHash,
  evictExpired,
  getRecord,
  recordCount,
  type ClaimOutcome,
} from '../idempotency.js';

// Frozen clocks. Tests advance them by hand to drive expiry.
function fixedClock(ms: number): { now: () => number; advance: (delta: number) => void } {
  let t = ms;
  return {
    now: () => t,
    advance: (delta: number) => {
      t += delta;
    },
  };
}

const HASH_A = computeRequestHash('POST', '/deliberate', '{"topic":"a"}');
const HASH_B = computeRequestHash('POST', '/deliberate', '{"topic":"b"}');

describe('computeRequestHash', () => {
  it('returns the same hex for identical inputs', () => {
    expect(HASH_A).toBe(computeRequestHash('POST', '/deliberate', '{"topic":"a"}'));
  });

  it('is byte-sensitive — whitespace flips the hash', () => {
    const a = computeRequestHash('POST', '/d', '{"x":1}');
    const b = computeRequestHash('POST', '/d', '{"x": 1}');
    expect(a).not.toBe(b);
  });

  it('upper-cases the method before hashing (so post == POST)', () => {
    expect(computeRequestHash('post', '/d', '{}')).toBe(
      computeRequestHash('POST', '/d', '{}'),
    );
  });

  it('separates fields with newlines so adjacency doesn\'t alias', () => {
    // Without a separator, ('PO','ST/d','{}') would collide with
    // ('POST','/d','{}'). The hash must distinguish the two.
    const a = computeRequestHash('POST', '/d', '{}');
    const b = computeRequestHash('POST/d', '', '{}');
    expect(a).not.toBe(b);
  });
});

describe('claimRecord — first writer', () => {
  let db: ReturnType<typeof initDb>;

  beforeEach(() => {
    db = initDb(':memory:');
  });

  it('returns "fresh" and inserts an in-flight row when no record exists', () => {
    const clock = fixedClock(1_700_000_000_000);
    const outcome: ClaimOutcome = claimRecord(
      db,
      {
        accountId: 'acct_1',
        key: 'key-1',
        method: 'POST',
        path: '/deliberate',
        requestHash: HASH_A,
      },
      { now: clock.now },
    );
    expect(outcome.kind).toBe('fresh');
    expect(recordCount(db)).toBe(1);

    const row = getRecord(db, 'acct_1', 'key-1', { now: clock.now });
    expect(row).not.toBeNull();
    expect(row!.lock_state).toBe('in_flight');
    expect(row!.request_hash).toBe(HASH_A);
    expect(row!.response_status).toBeNull();
    expect(row!.response_body).toBeNull();
  });

  it('returns "in_flight" when a concurrent claimant arrives mid-flight', () => {
    const clock = fixedClock(1_700_000_000_000);
    expect(
      claimRecord(
        db,
        { accountId: 'acct', key: 'k', method: 'POST', path: '/d', requestHash: HASH_A },
        { now: clock.now },
      ).kind,
    ).toBe('fresh');

    const second = claimRecord(
      db,
      { accountId: 'acct', key: 'k', method: 'POST', path: '/d', requestHash: HASH_A },
      { now: clock.now },
    );
    expect(second.kind).toBe('in_flight');
    if (second.kind === 'in_flight') {
      expect(second.record.lock_state).toBe('in_flight');
    }
  });

  it('returns "replay" once the first request has completed', () => {
    const clock = fixedClock(1_700_000_000_000);
    claimRecord(
      db,
      { accountId: 'a', key: 'k', method: 'POST', path: '/d', requestHash: HASH_A },
      { now: clock.now },
    );
    completeRecord(db, {
      accountId: 'a',
      key: 'k',
      status: 202,
      body: '{"id":"del_1"}',
      headers: { 'content-type': 'application/json' },
    });

    const replay = claimRecord(
      db,
      { accountId: 'a', key: 'k', method: 'POST', path: '/d', requestHash: HASH_A },
      { now: clock.now },
    );
    expect(replay.kind).toBe('replay');
    if (replay.kind === 'replay') {
      expect(replay.record.response_status).toBe(202);
      expect(replay.record.response_body).toBe('{"id":"del_1"}');
      expect(replay.record.lock_state).toBe('complete');
    }
  });

  it('returns "conflict" when the same key sees a different request hash', () => {
    const clock = fixedClock(1_700_000_000_000);
    claimRecord(
      db,
      { accountId: 'a', key: 'k', method: 'POST', path: '/d', requestHash: HASH_A },
      { now: clock.now },
    );
    const conflict = claimRecord(
      db,
      { accountId: 'a', key: 'k', method: 'POST', path: '/d', requestHash: HASH_B },
      { now: clock.now },
    );
    expect(conflict.kind).toBe('conflict');
    if (conflict.kind === 'conflict') {
      expect(conflict.record.request_hash).toBe(HASH_A);
    }
  });

  it('scopes claims to (account_id, key) — same key, different account = independent', () => {
    const clock = fixedClock(1_700_000_000_000);
    expect(
      claimRecord(
        db,
        { accountId: 'a', key: 'shared', method: 'POST', path: '/d', requestHash: HASH_A },
        { now: clock.now },
      ).kind,
    ).toBe('fresh');
    expect(
      claimRecord(
        db,
        { accountId: 'b', key: 'shared', method: 'POST', path: '/d', requestHash: HASH_B },
        { now: clock.now },
      ).kind,
    ).toBe('fresh');
    expect(recordCount(db)).toBe(2);
  });
});

describe('claimRecord — expiry', () => {
  let db: ReturnType<typeof initDb>;

  beforeEach(() => {
    db = initDb(':memory:');
  });

  it('treats an expired record as logically absent and overwrites it', () => {
    const clock = fixedClock(1_700_000_000_000);
    claimRecord(
      db,
      { accountId: 'a', key: 'k', method: 'POST', path: '/d', requestHash: HASH_A },
      { now: clock.now, ttlMs: 1_000 },
    );
    completeRecord(db, {
      accountId: 'a',
      key: 'k',
      status: 200,
      body: '{}',
      headers: {},
    });

    // Wind past expiry. A new claim with a DIFFERENT body must succeed
    // (no conflict, no replay) because the prior record is gone.
    clock.advance(2_000);
    const after = claimRecord(
      db,
      { accountId: 'a', key: 'k', method: 'POST', path: '/d', requestHash: HASH_B },
      { now: clock.now, ttlMs: 1_000 },
    );
    expect(after.kind).toBe('fresh');

    // Only one row at any given moment — the expired one was evicted in
    // the same transaction as the fresh insert.
    expect(recordCount(db)).toBe(1);
    const row = getRecord(db, 'a', 'k', { now: clock.now });
    expect(row!.request_hash).toBe(HASH_B);
  });

  it('"replay" still works while the record is non-expired', () => {
    const clock = fixedClock(1_700_000_000_000);
    claimRecord(
      db,
      { accountId: 'a', key: 'k', method: 'POST', path: '/d', requestHash: HASH_A },
      { now: clock.now, ttlMs: 5_000 },
    );
    completeRecord(db, { accountId: 'a', key: 'k', status: 200, body: 'r1', headers: {} });

    clock.advance(4_000); // still within TTL
    const replay = claimRecord(
      db,
      { accountId: 'a', key: 'k', method: 'POST', path: '/d', requestHash: HASH_A },
      { now: clock.now, ttlMs: 5_000 },
    );
    expect(replay.kind).toBe('replay');
  });
});

describe('completeRecord and abandonRecord', () => {
  let db: ReturnType<typeof initDb>;

  beforeEach(() => {
    db = initDb(':memory:');
  });

  it('completeRecord persists status, body, and headers', () => {
    claimRecord(db, {
      accountId: 'a',
      key: 'k',
      method: 'POST',
      path: '/d',
      requestHash: HASH_A,
    });
    const ok = completeRecord(db, {
      accountId: 'a',
      key: 'k',
      status: 202,
      body: '{"id":"del_1"}',
      headers: { 'content-type': 'application/json', location: '/deliberate/del_1' },
    });
    expect(ok).toBe(true);

    const row = getRecord(db, 'a', 'k');
    expect(row!.lock_state).toBe('complete');
    expect(row!.response_status).toBe(202);
    expect(row!.response_body).toBe('{"id":"del_1"}');
    const parsed = JSON.parse(row!.response_headers!) as Record<string, string>;
    expect(parsed['content-type']).toBe('application/json');
    expect(parsed['location']).toBe('/deliberate/del_1');
  });

  it('completeRecord returns false when no row exists', () => {
    const ok = completeRecord(db, {
      accountId: 'a',
      key: 'never_claimed',
      status: 200,
      body: '',
      headers: {},
    });
    expect(ok).toBe(false);
  });

  it('abandonRecord removes only in-flight rows', () => {
    claimRecord(db, {
      accountId: 'a',
      key: 'in_flight_key',
      method: 'POST',
      path: '/d',
      requestHash: HASH_A,
    });
    claimRecord(db, {
      accountId: 'a',
      key: 'complete_key',
      method: 'POST',
      path: '/d',
      requestHash: HASH_B,
    });
    completeRecord(db, {
      accountId: 'a',
      key: 'complete_key',
      status: 200,
      body: '{}',
      headers: {},
    });

    abandonRecord(db, 'a', 'in_flight_key');
    abandonRecord(db, 'a', 'complete_key');

    expect(getRecord(db, 'a', 'in_flight_key')).toBeNull();
    expect(getRecord(db, 'a', 'complete_key')).not.toBeNull();
  });
});

describe('evictExpired', () => {
  let db: ReturnType<typeof initDb>;

  beforeEach(() => {
    db = initDb(':memory:');
  });

  it('removes only rows past expires_at and reports the count', () => {
    const clock = fixedClock(1_700_000_000_000);
    claimRecord(
      db,
      { accountId: 'a', key: 'k1', method: 'POST', path: '/d', requestHash: HASH_A },
      { now: clock.now, ttlMs: 1_000 },
    );
    claimRecord(
      db,
      { accountId: 'a', key: 'k2', method: 'POST', path: '/d', requestHash: HASH_A },
      { now: clock.now, ttlMs: 10_000 },
    );

    clock.advance(2_000);
    const removed = evictExpired(db, { now: clock.now });
    expect(removed).toBe(1);
    expect(recordCount(db)).toBe(1);
    expect(getRecord(db, 'a', 'k2', { now: clock.now })).not.toBeNull();
  });

  it('returns 0 when nothing has expired', () => {
    const clock = fixedClock(1_700_000_000_000);
    claimRecord(
      db,
      { accountId: 'a', key: 'k', method: 'POST', path: '/d', requestHash: HASH_A },
      { now: clock.now, ttlMs: 60_000 },
    );
    expect(evictExpired(db, { now: clock.now })).toBe(0);
  });
});

describe('getRecord', () => {
  let db: ReturnType<typeof initDb>;

  beforeEach(() => {
    db = initDb(':memory:');
  });

  it('returns null for an unknown (account, key)', () => {
    expect(getRecord(db, 'nope', 'nope')).toBeNull();
  });

  it('returns null for an expired record without deleting it', () => {
    const clock = fixedClock(1_700_000_000_000);
    claimRecord(
      db,
      { accountId: 'a', key: 'k', method: 'POST', path: '/d', requestHash: HASH_A },
      { now: clock.now, ttlMs: 1_000 },
    );

    clock.advance(2_000);
    expect(getRecord(db, 'a', 'k', { now: clock.now })).toBeNull();
    // The row is still in the DB until evictExpired or claimRecord
    // overwrites it — this is fine for the middleware (it never sees an
    // expired record via getRecord) and lets the eviction sweep happen
    // on its own cadence.
    expect(recordCount(db)).toBe(1);
  });
});
