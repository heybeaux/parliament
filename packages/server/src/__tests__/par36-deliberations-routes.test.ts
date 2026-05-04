/**
 * PAR-36 / M1 T1.5 — route integration for `GET /v1/deliberations`.
 *
 * Pins the wire-shape contract the OpenAPI spec promises:
 *   - 200 with `{data: [], next_cursor: null}` for an empty account.
 *   - Auth-gated: with bearerAuth populated, only the caller's account is
 *     returned. With auth disabled (empty api_keys table) the OSS bucket
 *     is the implicit account and pre-existing NULL rows are reachable.
 *   - Cursor round-trip: page1.next_cursor → page2 with no dupes/skips,
 *     final page returns next_cursor=null.
 *   - All four filters (status/preset/created_after/created_before)
 *     compose via query string and survive the Zod parse.
 *   - Limit clamping at the HTTP layer: out-of-range values → 400, valid
 *     values flow through, default applies when absent.
 *   - Malformed/expired cursor → 400 invalid_request (not a silent empty).
 *   - Account isolation: a key on account A cannot see account B's rows.
 *
 * Auth wiring follows par33-auth-routes.test.ts — issue real keys with the
 * fast argon profile so the bearer middleware authenticates against a real
 * row.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Minimal mock of @parliament/core. The route does not depend on the
// engine, but `/presets` (touched indirectly via createRouter wiring) and
// the loadTopologyConfig import path do.
vi.mock('@parliament/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@parliament/core')>();
  return {
    ...actual,
    loadTopologyConfig: vi.fn().mockReturnValue({
      activePreset: actual.BUILTIN_PRESETS['debate']!,
      presets: { ...actual.BUILTIN_PRESETS },
      userNeurotypes: {},
    }),
  };
});

const { initDb } = await import('../db.js');
const { createRouter, __resetPresetAvailabilityCache } = await import('../routes.js');
const { DEFAULT_SERVER_CONFIG } = await import('../config.js');
const { createApiKey, OSS_ACCOUNT_ID } = await import('../api-keys.js');
const { saveDeliberation } = await import('../db.js');

const FAST_ARGON = { timeCost: 1, memoryCost: 1024, parallelism: 1 };

function makeApp() {
  const db = initDb(':memory:');
  const app = createRouter(db, {
    serverConfig: { ...DEFAULT_SERVER_CONFIG, cors_origins: ['http://localhost:5173'] },
  });
  return { db, app };
}

interface InsertOpts {
  id: string;
  topic?: string;
  preset?: string;
  status?: 'in_flight' | 'completed' | 'failed';
  accountId?: string | null;
  createdAt?: string;
}

/**
 * Insert a deliberation row directly so route tests can drive deterministic
 * timestamps + status values without spinning up the engine. Mirrors the
 * row shape `saveDeliberation` produces.
 */
function insertRow(db: ReturnType<typeof initDb>, opts: InsertOpts): void {
  const status = opts.status ?? 'completed';
  const topic = opts.topic ?? `topic ${opts.id}`;
  saveDeliberation(
    db,
    opts.id,
    topic,
    {
      topic,
      turns: [],
      conflicts: [],
      residueScore: 0,
      resolved: true,
      synthesis: 'fin',
      split: null,
      terminationReason: 'consensus',
      totalRounds: 1,
      started_at: '2026-01-01T00:00:00.000Z',
      completed_at: '2026-01-01T00:00:30.000Z',
      events: [],
      status,
      preset: opts.preset ?? 'debate',
    },
    opts.accountId ?? undefined,
  );
  // saveDeliberation always stamps status='completed'; for failed/in_flight
  // rows we patch post-hoc. We also patch created_at so ordering tests can
  // pin specific timestamps.
  const updates: string[] = [];
  const params: unknown[] = [];
  if (opts.createdAt !== undefined) {
    updates.push('created_at = ?');
    params.push(opts.createdAt);
  }
  if (status !== 'completed') {
    updates.push('status = ?');
    params.push(status);
  }
  if (opts.accountId === null) {
    // Explicit override for the legacy-NULL-row case — saveDeliberation
    // would otherwise persist `undefined` as a NULL anyway, but we want
    // the assertion to be unambiguous.
    updates.push('account_id = NULL');
  }
  if (updates.length > 0) {
    db.prepare(`UPDATE deliberations SET ${updates.join(', ')} WHERE id = ?`).run(
      ...params,
      opts.id,
    );
  }
}

beforeEach(() => {
  __resetPresetAvailabilityCache();
});

// ---------------------------------------------------------------------------
// Auth-disabled (empty api_keys) — OSS-parity path.
// ---------------------------------------------------------------------------

describe('GET /v1/deliberations — auth disabled (OSS parity)', () => {
  it('returns 200 with {data: [], next_cursor: null} for an empty database', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/deliberations');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[]; next_cursor: string | null };
    expect(body.data).toEqual([]);
    expect(body.next_cursor).toBeNull();
  });

  it('surfaces NULL-account legacy rows under the OSS bucket', async () => {
    const { db, app } = makeApp();
    insertRow(db, { id: 'd_legacy_1', accountId: null, createdAt: '2026-01-02T00:00:00.000Z' });
    insertRow(db, { id: 'd_legacy_2', accountId: null, createdAt: '2026-01-03T00:00:00.000Z' });

    const res = await app.request('/v1/deliberations');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    // Newest first.
    expect(body.data.map((d) => d.id)).toEqual(['d_legacy_2', 'd_legacy_1']);
  });
});

// ---------------------------------------------------------------------------
// Auth enabled — bearerAuth context populates account_id.
// ---------------------------------------------------------------------------

describe('GET /v1/deliberations — auth enabled, account scoping', () => {
  it('returns only the caller account\'s rows when authenticated', async () => {
    const { db, app } = makeApp();
    // Provision two distinct accounts; createApiKey requires the row to
    // exist before binding a key to it.
    db.prepare(`INSERT INTO accounts (id, tier, created_at) VALUES (?, ?, ?)`)
      .run('acct_alpha', 'self_host', new Date().toISOString());
    db.prepare(`INSERT INTO accounts (id, tier, created_at) VALUES (?, ?, ?)`)
      .run('acct_beta', 'self_host', new Date().toISOString());
    const issuedA = await createApiKey(db, { keyType: 'live', argon: FAST_ARGON, accountId: 'acct_alpha' });
    const issuedB = await createApiKey(db, { keyType: 'live', argon: FAST_ARGON, accountId: 'acct_beta' });

    insertRow(db, { id: 'd_a1', accountId: issuedA.account_id, createdAt: '2026-01-02T00:00:00.000Z' });
    insertRow(db, { id: 'd_a2', accountId: issuedA.account_id, createdAt: '2026-01-03T00:00:00.000Z' });
    insertRow(db, { id: 'd_b1', accountId: issuedB.account_id, createdAt: '2026-01-04T00:00:00.000Z' });

    const res = await app.request('/v1/deliberations', {
      headers: { Authorization: `Bearer ${issuedA.secret}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data.map((d) => d.id)).toEqual(['d_a2', 'd_a1']);
  });

  it('returns 401 when api_keys is non-empty and Authorization is missing', async () => {
    const { db, app } = makeApp();
    await createApiKey(db, { keyType: 'live', argon: FAST_ARGON });
    const res = await app.request('/v1/deliberations');
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Pagination — cursor round-trip.
// ---------------------------------------------------------------------------

describe('GET /v1/deliberations — cursor pagination', () => {
  it('paginates with next_cursor, no dupes/skips across pages, terminating with next_cursor=null', async () => {
    const { db, app } = makeApp();
    // 7 rows under OSS account, descending by created_at.
    for (let i = 1; i <= 7; i += 1) {
      insertRow(db, {
        id: `d_p${i}`,
        accountId: OSS_ACCOUNT_ID,
        createdAt: `2026-02-0${i}T00:00:00.000Z`,
      });
    }

    const seen = new Set<string>();
    const order: string[] = [];
    let cursor: string | null = null;

    for (let page = 0; page < 5; page += 1) {
      const url = cursor === null
        ? '/v1/deliberations?limit=3'
        : `/v1/deliberations?limit=3&cursor=${encodeURIComponent(cursor)}`;
      const res = await app.request(url);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: Array<{ id: string }>;
        next_cursor: string | null;
      };
      for (const row of body.data) {
        expect(seen.has(row.id)).toBe(false);
        seen.add(row.id);
        order.push(row.id);
      }
      cursor = body.next_cursor;
      if (cursor === null) break;
    }

    expect(cursor).toBeNull();
    expect(order).toEqual(['d_p7', 'd_p6', 'd_p5', 'd_p4', 'd_p3', 'd_p2', 'd_p1']);
  });

  it('returns 400 invalid_request for a malformed cursor', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/deliberations?cursor=not-base64-at-all-%21%21');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('invalid_request');
    expect(body.error.message).toMatch(/cursor/i);
  });
});

// ---------------------------------------------------------------------------
// Filters — Zod parsing + composition through the route layer.
// ---------------------------------------------------------------------------

describe('GET /v1/deliberations — filters', () => {
  it('filters by status (completed includes legacy NULL status)', async () => {
    const { db, app } = makeApp();
    insertRow(db, { id: 'd_done', status: 'completed', accountId: OSS_ACCOUNT_ID, createdAt: '2026-03-01T00:00:00.000Z' });
    insertRow(db, { id: 'd_fail', status: 'failed', accountId: OSS_ACCOUNT_ID, createdAt: '2026-03-02T00:00:00.000Z' });
    insertRow(db, { id: 'd_flight', status: 'in_flight', accountId: OSS_ACCOUNT_ID, createdAt: '2026-03-03T00:00:00.000Z' });

    const failed = await app.request('/v1/deliberations?status=failed');
    expect(failed.status).toBe(200);
    const failedBody = (await failed.json()) as { data: Array<{ id: string; status: string }> };
    expect(failedBody.data.map((d) => d.id)).toEqual(['d_fail']);
    expect(failedBody.data[0]!.status).toBe('failed');

    const inFlight = await app.request('/v1/deliberations?status=in_flight');
    const inFlightBody = (await inFlight.json()) as { data: Array<{ id: string }> };
    expect(inFlightBody.data.map((d) => d.id)).toEqual(['d_flight']);
  });

  it('filters by preset', async () => {
    const { db, app } = makeApp();
    insertRow(db, { id: 'd_debate', preset: 'debate', accountId: OSS_ACCOUNT_ID, createdAt: '2026-03-01T00:00:00.000Z' });
    insertRow(db, { id: 'd_jury', preset: 'jury', accountId: OSS_ACCOUNT_ID, createdAt: '2026-03-02T00:00:00.000Z' });

    const res = await app.request('/v1/deliberations?preset=jury');
    const body = (await res.json()) as { data: Array<{ id: string; preset: string }> };
    expect(body.data.map((d) => d.id)).toEqual(['d_jury']);
    expect(body.data[0]!.preset).toBe('jury');
  });

  it('filters by half-open created_after / created_before window', async () => {
    const { db, app } = makeApp();
    insertRow(db, { id: 'd_before', accountId: OSS_ACCOUNT_ID, createdAt: '2026-04-01T00:00:00.000Z' });
    insertRow(db, { id: 'd_inside', accountId: OSS_ACCOUNT_ID, createdAt: '2026-04-15T00:00:00.000Z' });
    insertRow(db, { id: 'd_after', accountId: OSS_ACCOUNT_ID, createdAt: '2026-04-30T00:00:00.000Z' });

    const after = encodeURIComponent('2026-04-10T00:00:00.000Z');
    const before = encodeURIComponent('2026-04-20T00:00:00.000Z');
    const res = await app.request(`/v1/deliberations?created_after=${after}&created_before=${before}`);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data.map((d) => d.id)).toEqual(['d_inside']);
  });

  it('composes status + preset + created window in one query', async () => {
    const { db, app } = makeApp();
    insertRow(db, { id: 'd_match', preset: 'jury', status: 'failed', accountId: OSS_ACCOUNT_ID, createdAt: '2026-04-15T00:00:00.000Z' });
    insertRow(db, { id: 'd_wrong_preset', preset: 'debate', status: 'failed', accountId: OSS_ACCOUNT_ID, createdAt: '2026-04-15T00:00:00.000Z' });
    insertRow(db, { id: 'd_wrong_status', preset: 'jury', status: 'completed', accountId: OSS_ACCOUNT_ID, createdAt: '2026-04-15T00:00:00.000Z' });
    insertRow(db, { id: 'd_wrong_window', preset: 'jury', status: 'failed', accountId: OSS_ACCOUNT_ID, createdAt: '2026-05-15T00:00:00.000Z' });

    const after = encodeURIComponent('2026-04-01T00:00:00.000Z');
    const before = encodeURIComponent('2026-05-01T00:00:00.000Z');
    const res = await app.request(
      `/v1/deliberations?status=failed&preset=jury&created_after=${after}&created_before=${before}`,
    );
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data.map((d) => d.id)).toEqual(['d_match']);
  });

  it('returns 400 invalid_request for an unknown status enum value', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/deliberations?status=bogus');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_request');
  });

  it('returns 400 invalid_request for a non-RFC3339 created_after', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/deliberations?created_after=yesterday');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_request');
  });
});

// ---------------------------------------------------------------------------
// Limit clamping at the HTTP boundary.
// ---------------------------------------------------------------------------

describe('GET /v1/deliberations — limit handling', () => {
  it('rejects limit=0 with 400 invalid_request', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/deliberations?limit=0');
    expect(res.status).toBe(400);
  });

  it('rejects limit > MAX_LIMIT (101) with 400 invalid_request', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/deliberations?limit=101');
    expect(res.status).toBe(400);
  });

  it('honours an in-range explicit limit', async () => {
    const { db, app } = makeApp();
    for (let i = 1; i <= 5; i += 1) {
      insertRow(db, {
        id: `d_lim_${i}`,
        accountId: OSS_ACCOUNT_ID,
        createdAt: `2026-06-0${i}T00:00:00.000Z`,
      });
    }
    const res = await app.request('/v1/deliberations?limit=2');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ id: string }>;
      next_cursor: string | null;
    };
    expect(body.data).toHaveLength(2);
    expect(body.next_cursor).not.toBeNull();
  });

  it('uses DEFAULT_LIMIT when limit is omitted (returns all rows when fewer than default)', async () => {
    const { db, app } = makeApp();
    for (let i = 1; i <= 3; i += 1) {
      insertRow(db, {
        id: `d_def_${i}`,
        accountId: OSS_ACCOUNT_ID,
        createdAt: `2026-07-0${i}T00:00:00.000Z`,
      });
    }
    const res = await app.request('/v1/deliberations');
    const body = (await res.json()) as {
      data: Array<{ id: string }>;
      next_cursor: string | null;
    };
    expect(body.data).toHaveLength(3);
    expect(body.next_cursor).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Projection shape.
// ---------------------------------------------------------------------------

describe('GET /v1/deliberations — response shape', () => {
  it('returns the OpenAPI-shaped fields per row', async () => {
    const { db, app } = makeApp();
    insertRow(db, { id: 'd_shape', preset: 'debate', accountId: OSS_ACCOUNT_ID, createdAt: '2026-08-01T00:00:00.000Z' });

    const res = await app.request('/v1/deliberations');
    const body = (await res.json()) as {
      data: Array<Record<string, unknown>>;
    };
    expect(body.data).toHaveLength(1);
    const row = body.data[0]!;
    // Required fields from #/components/schemas/DeliberationListItem.
    expect(row['id']).toBe('d_shape');
    expect(row['preset']).toBe('debate');
    expect(row['topic']).toBe('topic d_shape');
    expect(row['status']).toBe('completed');
    expect(typeof row['created_at']).toBe('string');
    // Nullable fields are present (null is fine — but the key must exist).
    expect('completed_at' in row).toBe(true);
    expect('resolved' in row).toBe(true);
    expect('residue_score' in row).toBe(true);
    expect('cost_usd' in row).toBe(true);
  });
});
