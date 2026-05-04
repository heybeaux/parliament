/**
 * PAR-33 / M1 T1.1 — route integration for DB-backed bearer auth and the
 * dashboard key-management endpoints.
 *
 * Pins the wire-shape contracts the public API (and dashboard surface) rely on:
 *   - Empty `api_keys` table → unauthenticated pass-through (OSS parity).
 *   - Once any key exists, every non-OPTIONS request must carry a valid
 *     `Authorization: Bearer pk_…`. Missing/malformed → 401, invalid/revoked
 *     → 403, with the canonical `{ error: { code, message } }` envelope.
 *   - Test keys are throttled at 10/min per key with a `Retry-After` header
 *     and `code: 'rate_limited'`. Live keys bypass the throttle entirely.
 *   - `POST /dashboard/api/keys` returns the secret EXACTLY once; subsequent
 *     `GET /dashboard/api/keys?account_id=…` reads strip it.
 *   - `DELETE /dashboard/api/keys/:id` is idempotent: 204 on first revoke,
 *     200 with `already_revoked: true` on the second.
 *   - The admin gate on `/dashboard/api/keys` is independent of bearer auth
 *     (uses PARLIAMENT_ADMIN_KEY) — wrong key → 403, missing → 403.
 *
 * Mocks @parliament/core minimally — only what `/presets` needs — so the
 * auth/throttle middleware runs against the real DB + real router.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// Minimal mock of @parliament/core. /presets needs loadTopologyConfig and
// the BUILTIN_PRESETS map; we keep the rest of the surface real so the
// route does not blow up on startup imports.
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
const { createApiKey, revokeApiKey } = await import('../api-keys.js');
const { testKeyThrottle } = await import('../middleware/keyThrottle.js');
const { bearerAuth } = await import('../middleware/auth.js');

// Cheap argon — keep the suite quick. Production defaults are exercised
// indirectly via the helper-level tests.
const FAST_ARGON = { timeCost: 1, memoryCost: 1024, parallelism: 1 };

// Hono Variables generic shape used by every isolated test app that reads or
// writes the auth-context keys set by `bearerAuth`. Without this, Hono's
// strict context typing rejects `c.set('authKeyType', …)` at compile time.
type AuthVars = {
  Variables: {
    authAccountId: string;
    authKeyId: string;
    authKeyType: 'test' | 'live';
  };
};

function makeApp(adminKey?: string) {
  const db = initDb(':memory:');
  const app = createRouter(db, {
    serverConfig: { ...DEFAULT_SERVER_CONFIG, cors_origins: ['http://localhost:5173'] },
    adminKey,
  });
  return { db, app };
}

beforeEach(() => {
  __resetPresetAvailabilityCache();
});

// ---------------------------------------------------------------------------
// AC1 — bearer auth: empty table passes through; populated table enforces.
// ---------------------------------------------------------------------------

describe('bearerAuth route integration', () => {
  it('passes through unauthenticated when api_keys is empty (OSS parity)', async () => {
    const { app } = makeApp();
    const res = await app.request('/presets');
    expect(res.status).toBe(200);
  });

  it('returns 401 authentication_required when the table is non-empty and Authorization is missing', async () => {
    const { db, app } = makeApp();
    await createApiKey(db, { keyType: 'test', argon: FAST_ARGON });

    const res = await app.request('/presets');
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('authentication_required');
    expect(body.error.message).toMatch(/Authorization/);
  });

  it('returns 401 authentication_required when the header is malformed', async () => {
    const { db, app } = makeApp();
    await createApiKey(db, { keyType: 'test', argon: FAST_ARGON });

    const res = await app.request('/presets', {
      headers: { Authorization: 'NotBearer something' },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('authentication_required');
  });

  it('returns 403 authentication_invalid when the bearer is unknown', async () => {
    const { db, app } = makeApp();
    await createApiKey(db, { keyType: 'test', argon: FAST_ARGON });

    const res = await app.request('/presets', {
      headers: { Authorization: 'Bearer pk_test_ABCDEFGHJK_unknownsecret' },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('authentication_invalid');
  });

  it('returns 403 authentication_invalid when the bearer is revoked', async () => {
    const { db, app } = makeApp();
    const issued = await createApiKey(db, { keyType: 'test', argon: FAST_ARGON });
    revokeApiKey(db, issued.id);

    const res = await app.request('/presets', {
      headers: { Authorization: `Bearer ${issued.secret}` },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('authentication_invalid');
    expect(body.error.message).toMatch(/revoked/i);
  });

  it('passes through with a valid live bearer', async () => {
    const { db, app } = makeApp();
    const issued = await createApiKey(db, { keyType: 'live', argon: FAST_ARGON });

    const res = await app.request('/presets', {
      headers: { Authorization: `Bearer ${issued.secret}` },
    });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// AC2 — test-key throttle. Live keys are unaffected by this limiter.
// ---------------------------------------------------------------------------

describe('testKeyThrottle middleware', () => {
  it('returns 429 rate_limited with Retry-After once a test key crosses the per-minute ceiling', async () => {
    // Build a tiny isolated app: skip the real router so we don't depend on
    // any /presets behavior, and set perMinute=2 to pin the boundary.
    const app = new Hono<AuthVars>();
    app.use('*', (c, next) => {
      c.set('authKeyType', 'test');
      c.set('authKeyId', 'key_under_test');
      return next();
    });
    app.use('*', testKeyThrottle({ perMinute: 2 }));
    app.get('/probe', (c) => c.json({ ok: true }));

    expect((await app.request('/probe')).status).toBe(200);
    expect((await app.request('/probe')).status).toBe(200);

    const blocked = await app.request('/probe');
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).not.toBeNull();
    const body = (await blocked.json()) as { error: { code: string } };
    expect(body.error.code).toBe('rate_limited');
  });

  it('does not throttle live keys', async () => {
    const app = new Hono<AuthVars>();
    app.use('*', (c, next) => {
      c.set('authKeyType', 'live');
      c.set('authKeyId', 'key_live');
      return next();
    });
    app.use('*', testKeyThrottle({ perMinute: 1 }));
    app.get('/probe', (c) => c.json({ ok: true }));

    // Five hits past the ceiling — all should pass for a live key.
    for (let i = 0; i < 5; i++) {
      expect((await app.request('/probe')).status).toBe(200);
    }
  });

  it('buckets per-key — one test key hitting its ceiling does not block another', async () => {
    const app = new Hono<AuthVars>();
    let currentId = 'a';
    app.use('*', (c, next) => {
      c.set('authKeyType', 'test');
      c.set('authKeyId', currentId);
      return next();
    });
    app.use('*', testKeyThrottle({ perMinute: 1 }));
    app.get('/probe', (c) => c.json({ ok: true }));

    expect((await app.request('/probe')).status).toBe(200);
    expect((await app.request('/probe')).status).toBe(429);

    currentId = 'b';
    expect((await app.request('/probe')).status).toBe(200);
  });

  it('passes through when no key_type is set in the context (OSS pass-through path)', async () => {
    const app = new Hono();
    app.use('*', testKeyThrottle({ perMinute: 1 }));
    app.get('/probe', (c) => c.json({ ok: true }));

    for (let i = 0; i < 3; i++) {
      expect((await app.request('/probe')).status).toBe(200);
    }
  });

  it('emits 401 on the wired router when a test key exceeds the ceiling, but only after the key is recognized', async () => {
    // End-to-end smoke: the wired router uses bearerAuth → testKeyThrottle.
    // Create a test key, hit /presets a few times beyond the limiter, and
    // confirm the throttle eventually surfaces. We DO NOT pin the exact
    // 10-request boundary here because that's a behavioral concern owned by
    // the unit test above; here we only confirm the middleware is wired.
    const { db, app } = makeApp();
    const issued = await createApiKey(db, { keyType: 'test', argon: FAST_ARGON });

    let saw429 = false;
    for (let i = 0; i < 12; i++) {
      const res = await app.request('/presets', {
        headers: { Authorization: `Bearer ${issued.secret}` },
      });
      if (res.status === 429) {
        saw429 = true;
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('rate_limited');
        break;
      }
      expect(res.status).toBe(200);
    }
    expect(saw429).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC3 — Dashboard key-management endpoints + admin gate.
// ---------------------------------------------------------------------------

describe('POST /dashboard/api/keys (admin-gated issuance)', () => {
  it('rejects with 403 when no admin key is configured', async () => {
    const { app } = makeApp(undefined);
    const res = await app.request('/dashboard/api/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key_type: 'test' }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('authentication_invalid');
  });

  it('rejects with 403 when the admin key is wrong', async () => {
    const { app } = makeApp('correct-admin-key');
    const res = await app.request('/dashboard/api/keys', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer wrong-admin-key',
      },
      body: JSON.stringify({ key_type: 'test' }),
    });
    expect(res.status).toBe(403);
  });

  it('issues a new key and returns the secret EXACTLY ONCE on 201', async () => {
    const { app } = makeApp('admin-secret');
    const res = await app.request('/dashboard/api/keys', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer admin-secret',
      },
      body: JSON.stringify({ key_type: 'test', name: 'CI smoke' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      account_id: string;
      key_type: 'test' | 'live';
      prefix: string;
      name: string | null;
      created_at: string;
      secret: string;
    };
    expect(body.id.startsWith('key_')).toBe(true);
    expect(body.account_id).toBe('acct_oss_self_host');
    expect(body.key_type).toBe('test');
    expect(body.prefix.startsWith('pk_test_')).toBe(true);
    expect(body.name).toBe('CI smoke');
    expect(body.secret.startsWith(body.prefix + '_')).toBe(true);
  });

  it('returns 400 invalid_request for a malformed body', async () => {
    const { app } = makeApp('admin-secret');
    const res = await app.request('/dashboard/api/keys', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer admin-secret',
      },
      body: JSON.stringify({ key_type: 'unsupported' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_request');
  });

  it('rejects unknown explicit account ids with 400', async () => {
    const { app } = makeApp('admin-secret');
    const res = await app.request('/dashboard/api/keys', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer admin-secret',
      },
      body: JSON.stringify({ account_id: 'acct_does_not_exist', key_type: 'test' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('invalid_request');
    expect(body.error.message).toMatch(/account not found/);
  });
});

describe('GET /dashboard/api/keys (admin-gated listing without secrets)', () => {
  it('rejects with 403 when admin auth is missing', async () => {
    const { app } = makeApp('admin-secret');
    const res = await app.request('/dashboard/api/keys');
    expect(res.status).toBe(403);
  });

  it('lists keys (without secrets) for the OSS account by default', async () => {
    const { db, app } = makeApp('admin-secret');
    const issued = await createApiKey(db, {
      keyType: 'test',
      name: 'k1',
      argon: FAST_ARGON,
    });

    const res = await app.request('/dashboard/api/keys', {
      headers: { Authorization: 'Bearer admin-secret' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      keys: Array<{ id: string; prefix: string; secret?: string }>;
    };
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]!.id).toBe(issued.id);
    expect(body.keys[0]).not.toHaveProperty('secret');
  });
});

describe('DELETE /dashboard/api/keys/:id (admin-gated revocation)', () => {
  it('rejects with 403 when admin auth is missing', async () => {
    const { app } = makeApp('admin-secret');
    const res = await app.request('/dashboard/api/keys/key_anything', {
      method: 'DELETE',
    });
    expect(res.status).toBe(403);
  });

  it('returns 404 when the key id is unknown', async () => {
    const { app } = makeApp('admin-secret');
    const res = await app.request('/dashboard/api/keys/key_does_not_exist', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer admin-secret' },
    });
    expect(res.status).toBe(404);
  });

  it('returns 204 on first revoke, 200 already_revoked on the second', async () => {
    const { db, app } = makeApp('admin-secret');
    const issued = await createApiKey(db, { keyType: 'test', argon: FAST_ARGON });

    const first = await app.request(`/dashboard/api/keys/${issued.id}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer admin-secret' },
    });
    expect(first.status).toBe(204);

    const second = await app.request(`/dashboard/api/keys/${issued.id}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer admin-secret' },
    });
    expect(second.status).toBe(200);
    const body = (await second.json()) as {
      already_revoked?: boolean;
      revoked_at?: string;
    };
    expect(body.already_revoked).toBe(true);
    expect(body.revoked_at).toBeTruthy();
  });

  it('revoked keys cannot authenticate the bearer middleware afterward', async () => {
    const { db, app } = makeApp('admin-secret');
    const issued = await createApiKey(db, { keyType: 'live', argon: FAST_ARGON });

    // Sanity: the key works before revocation.
    const before = await app.request('/presets', {
      headers: { Authorization: `Bearer ${issued.secret}` },
    });
    expect(before.status).toBe(200);

    // Revoke via the dashboard.
    const del = await app.request(`/dashboard/api/keys/${issued.id}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer admin-secret' },
    });
    expect(del.status).toBe(204);

    // The revoked key now fails auth.
    const after = await app.request('/presets', {
      headers: { Authorization: `Bearer ${issued.secret}` },
    });
    expect(after.status).toBe(403);
    const body = (await after.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('authentication_invalid');
    expect(body.error.message).toMatch(/revoked/i);
  });
});

// ---------------------------------------------------------------------------
// AC4 — bearerAuth context propagation. Verifies the middleware-set values
// reach handlers (used by the throttle and downstream metering).
// ---------------------------------------------------------------------------

describe('bearerAuth context propagation', () => {
  it('exposes account_id, key_id, and key_type to downstream handlers when auth succeeds', async () => {
    const db = initDb(':memory:');
    const issued = await createApiKey(db, { keyType: 'live', argon: FAST_ARGON });

    const app = new Hono<AuthVars>();
    app.use('*', bearerAuth(db));
    app.get('/whoami', (c) => {
      return c.json({
        account_id: c.get('authAccountId'),
        key_id: c.get('authKeyId'),
        key_type: c.get('authKeyType'),
      });
    });

    const res = await app.request('/whoami', {
      headers: { Authorization: `Bearer ${issued.secret}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      account_id: string;
      key_id: string;
      key_type: 'test' | 'live';
    };
    expect(body.account_id).toBe('acct_oss_self_host');
    expect(body.key_id).toBe(issued.id);
    expect(body.key_type).toBe('live');
  });

  it('does not set the context fields on the OSS pass-through path', async () => {
    const db = initDb(':memory:');
    const app = new Hono<AuthVars>();
    app.use('*', bearerAuth(db));
    app.get('/whoami', (c) => {
      return c.json({
        account_id: c.get('authAccountId') ?? null,
        key_type: c.get('authKeyType') ?? null,
      });
    });

    const res = await app.request('/whoami');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      account_id: string | null;
      key_type: string | null;
    };
    expect(body.account_id).toBeNull();
    expect(body.key_type).toBeNull();
  });
});
