/**
 * PAR-34 / M1 T1.2 — route integration for the Idempotency-Key middleware.
 *
 * Pins the wire-shape contracts the public API relies on:
 *   - No header → handler runs untouched, no record persisted.
 *   - Header + first request → handler runs, response is captured, record
 *     is persisted with `lock_state = 'complete'`.
 *   - Same key + same body → handler does NOT run; response is replayed
 *     verbatim with `Idempotent-Replayed: true`.
 *   - Same key + different body → 409 idempotency_conflict (handler not run).
 *   - Concurrent replay while in-flight → second caller waits and gets the
 *     same response; handler ran exactly once.
 *   - Handler throws → in-flight row is removed so the caller can retry.
 *   - Account-scoped: same key on a different account is independent.
 *
 * The bulk of the tests use a minimal Hono app so we can drive deterministic
 * handler behavior (throws, slow handlers). The final block runs against
 * the real `createRouter` to confirm the wiring composes with bearerAuth +
 * the test-key throttle.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { initDb } from '../db.js';
import { idempotency } from '../middleware/idempotency.js';
import { recordCount, getRecord } from '../idempotency.js';
import { AUTH_CTX_ACCOUNT_ID } from '../middleware/auth.js';

type AccountVars = { Variables: { authAccountId: string } };

function makeMinimalApp(
  db: ReturnType<typeof initDb>,
  handler: (callCount: { n: number }) => (c: import('hono').Context) => Promise<Response> | Response,
  options: Parameters<typeof idempotency>[1] = {},
): { app: Hono<AccountVars>; calls: { n: number } } {
  const calls = { n: 0 };
  const app = new Hono<AccountVars>();
  // Stub auth: every request lands as account 'acct_test' unless the
  // request explicitly sets a different value via header (used for the
  // account-scoping case).
  app.use('*', async (c, next) => {
    const overrideAccount = c.req.header('X-Test-Account');
    c.set(AUTH_CTX_ACCOUNT_ID, overrideAccount ?? 'acct_test');
    await next();
  });
  app.use('*', idempotency(db, options));
  app.post('/echo', handler(calls));
  return { app, calls };
}

describe('idempotency middleware — pass-through cases', () => {
  let db: ReturnType<typeof initDb>;
  beforeEach(() => {
    db = initDb(':memory:');
  });

  it('does not record anything when no Idempotency-Key header is sent', async () => {
    const { app } = makeMinimalApp(db, () => (c) => c.json({ ok: true }));
    const res = await app.request('/echo', { method: 'POST', body: '{}' });
    expect(res.status).toBe(200);
    expect(recordCount(db)).toBe(0);
  });

  it('does not run on non-POST methods', async () => {
    const { app, calls } = makeMinimalApp(db, (c) => () => {
      c.n += 1;
      return new Response(null, { status: 200 });
    });
    app.get('/echo', (c) => c.json({ ok: true }));

    const res = await app.request('/echo', {
      method: 'GET',
      headers: { 'Idempotency-Key': 'abc' },
    });
    expect(res.status).toBe(200);
    expect(recordCount(db)).toBe(0);
    expect(calls.n).toBe(0);
  });
});

describe('idempotency middleware — first-pass capture', () => {
  let db: ReturnType<typeof initDb>;
  beforeEach(() => {
    db = initDb(':memory:');
  });

  it('runs the handler exactly once and persists the response', async () => {
    const { app, calls } = makeMinimalApp(db, (c) => async (ctx) => {
      c.n += 1;
      return ctx.json({ id: 'del_1' }, 202);
    });

    const res = await app.request('/echo', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'replay-key-1',
      },
      body: JSON.stringify({ topic: 'a' }),
    });
    expect(res.status).toBe(202);
    expect(res.headers.get('Idempotent-Replayed')).toBe('false');
    const body = await res.json();
    expect(body).toEqual({ id: 'del_1' });
    expect(calls.n).toBe(1);

    // Record persisted with the full response.
    const row = getRecord(db, 'acct_test', 'replay-key-1');
    expect(row).not.toBeNull();
    expect(row!.lock_state).toBe('complete');
    expect(row!.response_status).toBe(202);
    const stored = JSON.parse(row!.response_body!);
    expect(stored).toEqual({ id: 'del_1' });
  });

  it('replays the cached response on the second pass without invoking the handler', async () => {
    const { app, calls } = makeMinimalApp(db, (c) => async (ctx) => {
      c.n += 1;
      return ctx.json({ id: `del_${c.n}` }, 202);
    });

    const first = await app.request('/echo', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'k', 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: 'a' }),
    });
    const firstBody = await first.json();

    const second = await app.request('/echo', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'k', 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: 'a' }),
    });
    expect(second.status).toBe(202);
    expect(second.headers.get('Idempotent-Replayed')).toBe('true');
    expect(await second.json()).toEqual(firstBody);
    expect(calls.n).toBe(1);
  });

  it('replays content-type from the original response', async () => {
    const { app } = makeMinimalApp(db, () => (c) => c.json({ x: 1 }));

    const first = await app.request('/echo', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'k', 'Content-Type': 'application/json' },
      body: '{"a":1}',
    });
    expect(first.headers.get('content-type')).toMatch(/application\/json/);

    const replay = await app.request('/echo', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'k', 'Content-Type': 'application/json' },
      body: '{"a":1}',
    });
    expect(replay.headers.get('content-type')).toMatch(/application\/json/);
  });
});

describe('idempotency middleware — conflict detection', () => {
  let db: ReturnType<typeof initDb>;
  beforeEach(() => {
    db = initDb(':memory:');
  });

  it('returns 409 idempotency_conflict when the same key sees a different body', async () => {
    const { app, calls } = makeMinimalApp(db, (c) => (ctx) => {
      c.n += 1;
      return ctx.json({ ok: true });
    });

    await app.request('/echo', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'k', 'Content-Type': 'application/json' },
      body: '{"topic":"a"}',
    });
    expect(calls.n).toBe(1);

    const conflict = await app.request('/echo', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'k', 'Content-Type': 'application/json' },
      body: '{"topic":"b"}',
    });
    expect(conflict.status).toBe(409);
    const body = (await conflict.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('idempotency_conflict');
    expect(body.error.message).toMatch(/different request body/);
    // The conflicting request did NOT invoke the handler again.
    expect(calls.n).toBe(1);
  });

  it('rejects a malformed Idempotency-Key (empty string) with 400', async () => {
    const { app, calls } = makeMinimalApp(db, (c) => (ctx) => {
      c.n += 1;
      return ctx.json({ ok: true });
    });
    const res = await app.request('/echo', {
      method: 'POST',
      headers: { 'Idempotency-Key': '   ' },
      body: '{}',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_request');
    expect(calls.n).toBe(0);
  });
});

describe('idempotency middleware — expiry', () => {
  let db: ReturnType<typeof initDb>;
  beforeEach(() => {
    db = initDb(':memory:');
  });

  it('after expiry, the same key with a different body is treated as fresh (not 409)', async () => {
    let t = 1_700_000_000_000;
    const clock = () => t;
    const { app, calls } = makeMinimalApp(
      db,
      (c) => (ctx) => {
        c.n += 1;
        return ctx.json({ id: `call_${c.n}` });
      },
      { now: clock, ttlMs: 1_000 },
    );

    const first = await app.request('/echo', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'k', 'Content-Type': 'application/json' },
      body: '{"topic":"a"}',
    });
    expect(first.status).toBe(200);

    // Wind past expiry. A different body MUST land as fresh — the prior
    // record is gone, so the conflict check has nothing to compare against.
    t += 5_000;

    const second = await app.request('/echo', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'k', 'Content-Type': 'application/json' },
      body: '{"topic":"b"}',
    });
    expect(second.status).toBe(200);
    expect(second.headers.get('Idempotent-Replayed')).toBe('false');
    expect(calls.n).toBe(2);
    const body = await second.json();
    expect(body).toEqual({ id: 'call_2' });
  });
});

describe('idempotency middleware — concurrent replay', () => {
  let db: ReturnType<typeof initDb>;
  beforeEach(() => {
    db = initDb(':memory:');
  });

  it('serialises concurrent same-body replays — handler runs once, both callers see the same response', async () => {
    let resolveSlowHandler: ((v: void) => void) | null = null;
    const slowHandlerPromise = new Promise<void>((r) => {
      resolveSlowHandler = r;
    });

    const { app, calls } = makeMinimalApp(
      db,
      (c) => async (ctx) => {
        c.n += 1;
        await slowHandlerPromise;
        return ctx.json({ id: 'del_x', call: c.n });
      },
      { pollIntervalMs: 5, pollTimeoutMs: 5_000 },
    );

    const first = app.request('/echo', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'k', 'Content-Type': 'application/json' },
      body: '{"topic":"a"}',
    });

    // Give the first request a chance to claim the lock before the second
    // one starts. (Without this, both could race to be 'fresh'.)
    await new Promise((r) => setTimeout(r, 10));

    const second = app.request('/echo', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'k', 'Content-Type': 'application/json' },
      body: '{"topic":"a"}',
    });

    // Let the in-flight handler finish.
    setTimeout(() => resolveSlowHandler!(), 10);

    const [firstRes, secondRes] = await Promise.all([first, second]);
    expect(firstRes.status).toBe(200);
    expect(secondRes.status).toBe(200);
    const firstBody = await firstRes.json();
    const secondBody = await secondRes.json();
    expect(secondBody).toEqual(firstBody);
    expect(calls.n).toBe(1);
    expect(secondRes.headers.get('Idempotent-Replayed')).toBe('true');
  });

  it('returns 409 if the in-flight request runs past the poll window', async () => {
    // Use a never-resolving handler + a small poll timeout so we can
    // exercise the timeout branch deterministically.
    const { app, calls } = makeMinimalApp(
      db,
      (c) => async () => {
        c.n += 1;
        await new Promise(() => {
          /* hang forever */
        });
        return new Response();
      },
      { pollIntervalMs: 5, pollTimeoutMs: 50 },
    );

    const first = app.request('/echo', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'k', 'Content-Type': 'application/json' },
      body: '{"a":1}',
    });
    await new Promise((r) => setTimeout(r, 10));
    const second = await app.request('/echo', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'k', 'Content-Type': 'application/json' },
      body: '{"a":1}',
    });
    expect(second.status).toBe(409);
    const body = (await second.json()) as { error: { code: string } };
    expect(body.error.code).toBe('idempotency_conflict');
    expect(calls.n).toBe(1);
    // Don't await `first` — it's hung on purpose. Test runner will
    // garbage-collect it.
    void first;
  });
});

describe('idempotency middleware — crash recovery', () => {
  let db: ReturnType<typeof initDb>;
  beforeEach(() => {
    db = initDb(':memory:');
  });

  it('removes the in-flight record when the handler throws, so a retry can proceed', async () => {
    let shouldThrow = true;
    const { app, calls } = makeMinimalApp(db, (c) => async (ctx) => {
      c.n += 1;
      if (shouldThrow) throw new Error('boom');
      return ctx.json({ ok: true, call: c.n });
    });

    // Hono surfaces uncaught throws as 500 by default. We don't care about
    // the exact response — only that the record is cleaned up so the next
    // call lands as fresh.
    const first = await app.request('/echo', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'k', 'Content-Type': 'application/json' },
      body: '{"a":1}',
    });
    expect(first.status).toBe(500);
    expect(getRecord(db, 'acct_test', 'k')).toBeNull();

    shouldThrow = false;
    const second = await app.request('/echo', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'k', 'Content-Type': 'application/json' },
      body: '{"a":1}',
    });
    expect(second.status).toBe(200);
    expect(calls.n).toBe(2);
  });
});

describe('idempotency middleware — account scoping', () => {
  let db: ReturnType<typeof initDb>;
  beforeEach(() => {
    db = initDb(':memory:');
  });

  it('treats the same key on different accounts as independent', async () => {
    const { app, calls } = makeMinimalApp(db, (c) => (ctx) => {
      c.n += 1;
      return ctx.json({ call: c.n });
    });

    const a = await app.request('/echo', {
      method: 'POST',
      headers: {
        'Idempotency-Key': 'shared',
        'X-Test-Account': 'acct_a',
        'Content-Type': 'application/json',
      },
      body: '{"a":1}',
    });
    const b = await app.request('/echo', {
      method: 'POST',
      headers: {
        'Idempotency-Key': 'shared',
        'X-Test-Account': 'acct_b',
        'Content-Type': 'application/json',
      },
      // Note: different body. If accounts shared a namespace, this would
      // 409 against `acct_a`'s record. They shouldn't.
      body: '{"a":2}',
    });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(calls.n).toBe(2);
    expect(recordCount(db)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// End-to-end smoke against the wired router. Confirms the middleware order
// (auth → throttle → idempotency → handler) actually composes.
// ---------------------------------------------------------------------------

vi.mock('@parliament/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@parliament/core')>();
  const mockResult = {
    topic: 'mocked',
    turns: [],
    conflicts: [],
    residueScore: 0,
    resolved: true,
    synthesis: null,
    split: null,
    terminationReason: 'consensus' as const,
    totalRounds: 0,
    started_at: '2026-01-01T00:00:00.000Z',
    completed_at: '2026-01-01T00:00:01.000Z',
    events: [],
  };
  const MockEngine = vi.fn().mockImplementation(() => ({
    runTopology: vi.fn().mockResolvedValue(mockResult),
  }));
  return {
    ...actual,
    DeliberationEngine: MockEngine,
    loadTopologyConfig: vi.fn().mockReturnValue({
      activePreset: actual.BUILTIN_PRESETS['debate']!,
      presets: { ...actual.BUILTIN_PRESETS },
      userNeurotypes: {},
    }),
    loadConfig: vi.fn().mockReturnValue({
      neurotypes: {
        proposer: { model: 'mock', system_prompt: '' },
        skeptic: { model: 'mock', system_prompt: '' },
        synthesizer: { model: 'mock', system_prompt: '' },
        redAgent: { model: 'mock', system_prompt: '' },
        sentry: { model: 'mock', system_prompt: '' },
      },
    }),
    createAdapter: vi.fn().mockReturnValue({
      generate: vi.fn().mockResolvedValue({ content: 'ok' }),
    }),
    buildAgentsFromConfig: vi.fn().mockReturnValue([]),
  };
});

const { createRouter } = await import('../routes.js');
const { DEFAULT_SERVER_CONFIG } = await import('../config.js');

describe('idempotency middleware — wired into createRouter', () => {
  it('replays a /deliberate POST with the same body and Idempotency-Key', async () => {
    const db = initDb(':memory:');
    const app = createRouter(db, {
      serverConfig: { ...DEFAULT_SERVER_CONFIG, cors_origins: ['http://localhost:5173'] },
    });

    const first = await app.request('/deliberate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'wired-1',
      },
      body: JSON.stringify({ topic: 'is this on?' }),
    });
    expect(first.status).toBe(202);
    const firstBody = await first.json();
    expect(firstBody).toHaveProperty('id');

    const second = await app.request('/deliberate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'wired-1',
      },
      body: JSON.stringify({ topic: 'is this on?' }),
    });
    expect(second.status).toBe(202);
    expect(second.headers.get('Idempotent-Replayed')).toBe('true');
    expect(await second.json()).toEqual(firstBody);
  });

  it('returns 409 on /deliberate when the same key sees a different topic', async () => {
    const db = initDb(':memory:');
    const app = createRouter(db, {
      serverConfig: { ...DEFAULT_SERVER_CONFIG, cors_origins: ['http://localhost:5173'] },
    });

    await app.request('/deliberate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'k' },
      body: JSON.stringify({ topic: 'a' }),
    });
    const conflict = await app.request('/deliberate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'k' },
      body: JSON.stringify({ topic: 'b' }),
    });
    expect(conflict.status).toBe(409);
    const body = (await conflict.json()) as { error: { code: string } };
    expect(body.error.code).toBe('idempotency_conflict');
  });

  it('passes through with no header (no record persisted)', async () => {
    const db = initDb(':memory:');
    const app = createRouter(db, {
      serverConfig: { ...DEFAULT_SERVER_CONFIG, cors_origins: ['http://localhost:5173'] },
    });
    const res = await app.request('/deliberate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: 'untracked' }),
    });
    expect(res.status).toBe(202);
    expect(recordCount(db)).toBe(0);
  });

  it('does not apply to /dashboard/api/keys POST (admin endpoints are exempt)', async () => {
    const db = initDb(':memory:');
    const app = createRouter(db, {
      serverConfig: { ...DEFAULT_SERVER_CONFIG, cors_origins: ['http://localhost:5173'] },
      adminKey: 'admin-secret',
    });

    // Two key-issuance calls with the same Idempotency-Key MUST mint two
    // distinct keys (idempotency would otherwise replay the secret, which
    // is wrong: the secret is only ever returned once).
    const first = await app.request('/dashboard/api/keys', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer admin-secret',
        'Idempotency-Key': 'shared',
      },
      body: JSON.stringify({ key_type: 'test' }),
    });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { id: string; secret: string };

    const second = await app.request('/dashboard/api/keys', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer admin-secret',
        'Idempotency-Key': 'shared',
      },
      body: JSON.stringify({ key_type: 'test' }),
    });
    expect(second.status).toBe(201);
    const secondBody = (await second.json()) as { id: string; secret: string };

    expect(secondBody.id).not.toBe(firstBody.id);
    expect(secondBody.secret).not.toBe(firstBody.secret);
    // No idempotency record was created for the dashboard call.
    expect(recordCount(db)).toBe(0);
  });
});
