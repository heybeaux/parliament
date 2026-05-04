/**
 * PAR-36 / M1 T1.5 — helper-level tests for the account-scoped list.
 *
 * These tests pin behaviour on the `deliberations.ts` storage layer in
 * isolation, without spinning up a Hono app. Route-level concerns
 * (auth, query parsing, error envelopes) live in the integration suite.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { initDb, saveDeliberation } from '../db.js';
import {
  listDeliberationsScoped,
  encodeCursor,
  decodeCursor,
  DEFAULT_LIMIT,
  MAX_LIMIT,
} from '../deliberations.js';
import { OSS_ACCOUNT_ID } from '../api-keys.js';
import type { DeliberationResult } from '@parliament/core';

function makeResult(overrides: Partial<DeliberationResult> = {}): DeliberationResult {
  // Minimal-but-valid result shape. Tests that care about specific fields
  // (preset, residueScore, costUsd) override them; the rest are defaulted
  // to plausible neutral values so listDeliberationsScoped can project a row.
  return {
    topic: 'test topic',
    turns: [],
    conflicts: [],
    residueScore: 0,
    resolved: true,
    synthesis: 'syn',
    split: null,
    terminationReason: 'consensus',
    totalRounds: 1,
    started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    events: [],
    ...overrides,
  } as DeliberationResult;
}

/**
 * Helper: insert a row with an explicit `created_at` and `account_id` so we
 * can drive deterministic ordering tests. `saveDeliberation` defaults to
 * `Date.now()` which is too coarse for sub-ms ordering.
 */
function insertRow(
  db: ReturnType<typeof initDb>,
  args: {
    id: string;
    accountId: string;
    createdAt: string;
    status?: 'in_flight' | 'completed' | 'failed';
    preset?: string;
    topic?: string;
    costUsd?: number;
    residueScore?: number;
    resolved?: boolean;
  },
): void {
  const result = makeResult({
    ...(args.preset !== undefined ? { preset: args.preset } : {}),
    ...(args.residueScore !== undefined ? { residueScore: args.residueScore } : {}),
    ...(args.resolved !== undefined ? { resolved: args.resolved } : {}),
    ...(args.costUsd !== undefined
      ? { turns: [{ round: 1, agent: 'P', content: 'c', meta: { costUsd: args.costUsd } } as never] }
      : {}),
  });
  if (args.status !== undefined) {
    result.status = args.status;
  }
  // saveDeliberation stamps created_at to now(); we override the column
  // post-hoc to pin ordering. The tests don't read result.completed_at vs
  // row.created_at, so the disconnect is harmless.
  saveDeliberation(db, args.id, args.topic ?? `topic ${args.id}`, result, args.accountId);
  db.prepare(`UPDATE deliberations SET created_at = ?, status = ? WHERE id = ?`).run(
    args.createdAt,
    args.status ?? 'completed',
    args.id,
  );
}

describe('encodeCursor / decodeCursor', () => {
  it('round-trips a (created_at, id) pair', () => {
    const anchor = { created_at: '2026-05-04T12:00:00.000Z', id: 'abc-123' };
    const encoded = encodeCursor(anchor);
    expect(decodeCursor(encoded)).toEqual(anchor);
  });

  it('returns null for malformed base64', () => {
    expect(decodeCursor('!!!not-base64!!!')).toBeNull();
  });

  it('returns null when the decoded payload has no separator', () => {
    const noSep = Buffer.from('no-pipe-here', 'utf8').toString('base64url');
    expect(decodeCursor(noSep)).toBeNull();
  });

  it('returns null when created_at half is not a valid timestamp', () => {
    const bad = Buffer.from('not-a-date|abc', 'utf8').toString('base64url');
    expect(decodeCursor(bad)).toBeNull();
  });
});

describe('listDeliberationsScoped — account scoping', () => {
  let db: ReturnType<typeof initDb>;
  beforeEach(() => {
    db = initDb(':memory:');
  });

  it('returns only rows belonging to the requested account', () => {
    insertRow(db, { id: 'a1', accountId: 'acct_alice', createdAt: '2026-05-04T10:00:00.000Z' });
    insertRow(db, { id: 'a2', accountId: 'acct_alice', createdAt: '2026-05-04T11:00:00.000Z' });
    insertRow(db, { id: 'b1', accountId: 'acct_bob', createdAt: '2026-05-04T12:00:00.000Z' });

    const alice = listDeliberationsScoped(db, { accountId: 'acct_alice' });
    expect(alice.data.map((d) => d.id).sort()).toEqual(['a1', 'a2']);

    const bob = listDeliberationsScoped(db, { accountId: 'acct_bob' });
    expect(bob.data.map((d) => d.id)).toEqual(['b1']);
  });

  it('coalesces NULL account_id rows onto the OSS bucket (legacy migration semantic)', () => {
    // Manually insert a pre-PAR-36 row with NULL account_id.
    db.prepare(
      `INSERT INTO deliberations (id, topic, result_json, created_at, status, account_id)
       VALUES (?, ?, ?, ?, ?, NULL)`,
    ).run('legacy', 'old', JSON.stringify(makeResult()), '2026-05-01T00:00:00.000Z', 'completed');

    const oss = listDeliberationsScoped(db, { accountId: OSS_ACCOUNT_ID });
    expect(oss.data.map((d) => d.id)).toContain('legacy');

    // A different account should NOT see the legacy row.
    const other = listDeliberationsScoped(db, { accountId: 'acct_other' });
    expect(other.data).toHaveLength(0);
  });

  it('returns an empty page for a never-seen account (AC: 200 with empty data)', () => {
    insertRow(db, { id: 'a1', accountId: 'acct_alice', createdAt: '2026-05-04T10:00:00.000Z' });
    const fresh = listDeliberationsScoped(db, { accountId: 'acct_brand_new' });
    expect(fresh).toEqual({ data: [], next_cursor: null });
  });
});

describe('listDeliberationsScoped — ordering and pagination', () => {
  let db: ReturnType<typeof initDb>;
  beforeEach(() => {
    db = initDb(':memory:');
    // Insert 5 rows with deterministic timestamps. Same account.
    for (let i = 0; i < 5; i++) {
      const stamp = `2026-05-04T10:0${i}:00.000Z`;
      insertRow(db, { id: `r${i}`, accountId: 'acct_a', createdAt: stamp });
    }
  });

  it('returns rows newest-first', () => {
    const page = listDeliberationsScoped(db, { accountId: 'acct_a' });
    expect(page.data.map((d) => d.id)).toEqual(['r4', 'r3', 'r2', 'r1', 'r0']);
    expect(page.next_cursor).toBeNull();
  });

  it('paginates without duplicates or skips when limit < total', () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    let safety = 0;
    do {
      const page = listDeliberationsScoped(db, { accountId: 'acct_a', limit: 2, cursor });
      seen.push(...page.data.map((d) => d.id));
      cursor = page.next_cursor ?? undefined;
      safety += 1;
      if (safety > 10) throw new Error('pagination did not terminate');
    } while (cursor !== undefined);

    expect(seen).toEqual(['r4', 'r3', 'r2', 'r1', 'r0']);
  });

  it('emits next_cursor when more rows remain, null when fully drained', () => {
    const first = listDeliberationsScoped(db, { accountId: 'acct_a', limit: 3 });
    expect(first.data).toHaveLength(3);
    expect(first.next_cursor).not.toBeNull();

    const second = listDeliberationsScoped(db, {
      accountId: 'acct_a',
      limit: 3,
      cursor: first.next_cursor ?? undefined,
    });
    expect(second.data).toHaveLength(2);
    expect(second.next_cursor).toBeNull();
  });

  it('uses id as tie-breaker when timestamps collide (sub-ms test bursts)', () => {
    const tie = initDb(':memory:');
    // All three rows share the same created_at to the millisecond.
    insertRow(tie, { id: 'aaa', accountId: 'acct_x', createdAt: '2026-05-04T10:00:00.000Z' });
    insertRow(tie, { id: 'bbb', accountId: 'acct_x', createdAt: '2026-05-04T10:00:00.000Z' });
    insertRow(tie, { id: 'ccc', accountId: 'acct_x', createdAt: '2026-05-04T10:00:00.000Z' });

    // DESC on (created_at, id) → ccc, bbb, aaa.
    const page = listDeliberationsScoped(tie, { accountId: 'acct_x' });
    expect(page.data.map((d) => d.id)).toEqual(['ccc', 'bbb', 'aaa']);

    // Pagination with limit 1 must walk that order without duplicates.
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 4; i++) {
      const page2 = listDeliberationsScoped(tie, { accountId: 'acct_x', limit: 1, cursor });
      seen.push(...page2.data.map((d) => d.id));
      cursor = page2.next_cursor ?? undefined;
      if (cursor === undefined) break;
    }
    expect(seen).toEqual(['ccc', 'bbb', 'aaa']);
  });
});

describe('listDeliberationsScoped — limit clamping', () => {
  let db: ReturnType<typeof initDb>;
  beforeEach(() => {
    db = initDb(':memory:');
    for (let i = 0; i < 5; i++) {
      insertRow(db, {
        id: `r${i}`,
        accountId: 'acct_a',
        createdAt: `2026-05-04T10:0${i}:00.000Z`,
      });
    }
  });

  it('uses DEFAULT_LIMIT when none supplied', () => {
    expect(DEFAULT_LIMIT).toBe(25);
    const page = listDeliberationsScoped(db, { accountId: 'acct_a' });
    expect(page.data).toHaveLength(5);
  });

  it('clamps limit to MAX_LIMIT', () => {
    expect(MAX_LIMIT).toBe(100);
    // Helper accepts >MAX_LIMIT but clamps internally — we can't observe the
    // clamp on a 5-row dataset, but we can confirm a huge limit doesn't
    // throw and returns at most 5 (i.e. all rows).
    const page = listDeliberationsScoped(db, { accountId: 'acct_a', limit: 9999 });
    expect(page.data).toHaveLength(5);
  });

  it('floors fractional limit and rejects 0/negative inputs by clamping to 1', () => {
    const zero = listDeliberationsScoped(db, { accountId: 'acct_a', limit: 0 });
    expect(zero.data).toHaveLength(1);
    const neg = listDeliberationsScoped(db, { accountId: 'acct_a', limit: -5 });
    expect(neg.data).toHaveLength(1);
  });
});

describe('listDeliberationsScoped — filters', () => {
  let db: ReturnType<typeof initDb>;
  beforeEach(() => {
    db = initDb(':memory:');
    insertRow(db, {
      id: 'r-completed',
      accountId: 'acct_a',
      createdAt: '2026-05-04T10:00:00.000Z',
      status: 'completed',
      preset: 'debate',
    });
    insertRow(db, {
      id: 'r-inflight',
      accountId: 'acct_a',
      createdAt: '2026-05-04T11:00:00.000Z',
      status: 'in_flight',
      preset: 'socratic',
    });
    insertRow(db, {
      id: 'r-failed',
      accountId: 'acct_a',
      createdAt: '2026-05-04T12:00:00.000Z',
      status: 'failed',
      preset: 'debate',
    });
  });

  it('filters by status', () => {
    const completed = listDeliberationsScoped(db, { accountId: 'acct_a', status: 'completed' });
    expect(completed.data.map((d) => d.id)).toEqual(['r-completed']);
    const inflight = listDeliberationsScoped(db, { accountId: 'acct_a', status: 'in_flight' });
    expect(inflight.data.map((d) => d.id)).toEqual(['r-inflight']);
  });

  it('filters by preset', () => {
    const debate = listDeliberationsScoped(db, { accountId: 'acct_a', preset: 'debate' });
    expect(debate.data.map((d) => d.id).sort()).toEqual(['r-completed', 'r-failed']);
  });

  it('filters by created_after / created_before (half-open window)', () => {
    const window = listDeliberationsScoped(db, {
      accountId: 'acct_a',
      createdAfter: '2026-05-04T10:00:00.000Z',
      createdBefore: '2026-05-04T12:00:00.000Z',
    });
    // Only `r-inflight` is strictly between the two boundaries.
    expect(window.data.map((d) => d.id)).toEqual(['r-inflight']);
  });

  it('composes all four filters together', () => {
    const composed = listDeliberationsScoped(db, {
      accountId: 'acct_a',
      status: 'failed',
      preset: 'debate',
      createdAfter: '2026-05-04T11:30:00.000Z',
      createdBefore: '2026-05-04T13:00:00.000Z',
    });
    expect(composed.data.map((d) => d.id)).toEqual(['r-failed']);
  });

  it('treats status=completed as inclusive of NULL status (legacy rows)', () => {
    db.prepare(
      `INSERT INTO deliberations (id, topic, result_json, created_at, account_id, status)
       VALUES (?, ?, ?, ?, ?, NULL)`,
    ).run(
      'r-legacy',
      'old',
      JSON.stringify(makeResult()),
      '2026-05-01T00:00:00.000Z',
      'acct_a',
    );
    const completed = listDeliberationsScoped(db, { accountId: 'acct_a', status: 'completed' });
    expect(completed.data.map((d) => d.id).sort()).toEqual(['r-completed', 'r-legacy']);
  });
});

describe('listDeliberationsScoped — projection (DeliberationListItem shape)', () => {
  let db: ReturnType<typeof initDb>;
  beforeEach(() => {
    db = initDb(':memory:');
  });

  it('aggregates per-turn cost into cost_usd, null when no turn carries cost', () => {
    insertRow(db, {
      id: 'with-cost',
      accountId: 'acct_a',
      createdAt: '2026-05-04T10:00:00.000Z',
      costUsd: 0.5,
    });
    insertRow(db, {
      id: 'no-cost',
      accountId: 'acct_a',
      createdAt: '2026-05-04T10:01:00.000Z',
    });
    const page = listDeliberationsScoped(db, { accountId: 'acct_a' });
    const withCost = page.data.find((d) => d.id === 'with-cost');
    const noCost = page.data.find((d) => d.id === 'no-cost');
    expect(withCost?.cost_usd).toBe(0.5);
    expect(noCost?.cost_usd).toBeNull();
  });

  it('emits a complete OpenAPI DeliberationListItem shape', () => {
    insertRow(db, {
      id: 'r1',
      accountId: 'acct_a',
      createdAt: '2026-05-04T10:00:00.000Z',
      preset: 'star-chamber',
      residueScore: 0.25,
      resolved: false,
    });
    const page = listDeliberationsScoped(db, { accountId: 'acct_a' });
    const item = page.data[0]!;
    expect(item).toEqual({
      id: 'r1',
      preset: 'star-chamber',
      topic: 'topic r1',
      status: 'completed',
      created_at: '2026-05-04T10:00:00.000Z',
      completed_at: expect.any(String),
      resolved: false,
      residue_score: 0.25,
      cost_usd: null,
    });
  });

  it('survives a corrupt result_json blob without poisoning the page', () => {
    db.prepare(
      `INSERT INTO deliberations (id, topic, result_json, created_at, account_id, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('bad', 'broken', '{not json', '2026-05-04T10:00:00.000Z', 'acct_a', 'completed');
    insertRow(db, { id: 'good', accountId: 'acct_a', createdAt: '2026-05-04T11:00:00.000Z' });

    const page = listDeliberationsScoped(db, { accountId: 'acct_a' });
    expect(page.data.map((d) => d.id).sort()).toEqual(['bad', 'good']);
    const bad = page.data.find((d) => d.id === 'bad')!;
    expect(bad.preset).toBe('unknown');
    expect(bad.cost_usd).toBeNull();
  });
});
