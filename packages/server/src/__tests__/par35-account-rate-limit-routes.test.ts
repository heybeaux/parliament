/**
 * PAR-35 / M1 T1.3 — route integration for the account-scoped rate limiter.
 *
 * Pins the wire-level contract the OpenAPI spec promises:
 *   - All six `X-RateLimit-*` headers appear on every authenticated response,
 *     including 4xx and 5xx, including non-POST GETs.
 *   - 429 `rate_limited` with `Retry-After` when the burst bucket is
 *     exhausted on a paid tier.
 *   - 429 `usage_limit_exceeded` when the envelope ceiling is reached.
 *   - 409 `concurrency_exceeded` for in-flight POSTs at the cap.
 *   - OSS pass-through (empty `api_keys`) emits no headers and is never
 *     rejected by this layer.
 *   - Test keys (PAR-33 `keyType: 'test'`) bypass entirely — keyThrottle
 *     is the only meter for them.
 *   - Unlimited tiers (oss / enterprise) emit headers with null limits but
 *     never reject.
 *   - Fail-open default: counter throws → request still proceeds with a
 *     console.warn; failClosed is opt-in (covered at the helper layer).
 *
 * Engine, topology config, and adapters are mocked so the POST path
 * doesn't actually fire the deliberation runtime — we only care about the
 * limiter's admission decision and the wire shape it produces.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DeliberationResult, Turn, SystemEvent } from '@parliament/core';

interface ScriptedRun {
  turns?: Turn[];
  events?: SystemEvent[];
  result?: DeliberationResult;
  hold?: () => Promise<void>;
}

const scripts: { current: ScriptedRun | null } = { current: null };

vi.mock('@parliament/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@parliament/core')>();
  const MockEngine = vi.fn().mockImplementation(() => ({
    runTopology: vi.fn().mockImplementation(
      async (
        _topic: string,
        config: { onTurn?: (t: Turn) => void; onEvent?: (e: SystemEvent) => void },
      ) => {
        const script = scripts.current;
        if (script === null) throw new Error('engine mock: no script set');
        for (const t of script.turns ?? []) config.onTurn?.(t);
        for (const e of script.events ?? []) config.onEvent?.(e);
        if (script.hold !== undefined) await script.hold();
        if (script.result === undefined) throw new Error('engine mock: no result');
        return script.result;
      },
    ),
    run: vi.fn().mockResolvedValue(null),
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
      modelName: 'mock-model',
      generate: vi.fn().mockResolvedValue({ content: 'ok' }),
    }),
  };
});

const { initDb } = await import('../db.js');
const { createRouter, __resetPresetAvailabilityCache } = await import('../routes.js');
const { createApiKey } = await import('../api-keys.js');
const { inflightBroker } = await import('../inflight.js');
const { DEFAULT_SERVER_CONFIG } = await import('../config.js');
import type { EnvelopeCounter } from '../accountLimiter.js';
import type { CreateRouterOptions } from '../routes.js';

const FAST_ARGON = { timeCost: 1, memoryCost: 1024, parallelism: 1 };

function baseResult(over: Partial<DeliberationResult> = {}): DeliberationResult {
  return {
    topic: 't',
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
    status: 'completed',
    ...over,
  };
}

function provisionAccount(
  db: ReturnType<typeof initDb>,
  id: string,
  tier: string,
): void {
  db.prepare(`INSERT INTO accounts (id, tier, created_at) VALUES (?, ?, ?)`)
    .run(id, tier, new Date().toISOString());
}

function makeApp(opts: {
  counter?: EnvelopeCounter;
  now?: () => number;
  envelopeCacheTtlMs?: number;
  onLimited?: (
    kind: 'rate_limited' | 'usage_limit_exceeded' | 'concurrency_exceeded',
    accountId: string,
  ) => void;
} = {}) {
  const db = initDb(':memory:');
  const overrides: NonNullable<CreateRouterOptions['accountRateLimitOverrides']> = {};
  if (opts.counter !== undefined) overrides.counter = opts.counter;
  if (opts.now !== undefined) overrides.now = opts.now;
  if (opts.envelopeCacheTtlMs !== undefined) overrides.envelopeCacheTtlMs = opts.envelopeCacheTtlMs;
  if (opts.onLimited !== undefined) overrides.onLimited = opts.onLimited;
  const app = createRouter(db, {
    serverConfig: { ...DEFAULT_SERVER_CONFIG, cors_origins: ['http://localhost:5173'] },
    accountRateLimitOverrides: overrides,
  });
  return { db, app };
}

function fixedClock(start: number): { now: () => number; advance: (delta: number) => void } {
  let t = start;
  return { now: () => t, advance: (d: number) => { t += d; } };
}

const RATE_HEADERS = {
  TIER: 'x-ratelimit-tier',
  LIMIT: 'x-ratelimit-limit',
  REMAINING: 'x-ratelimit-remaining',
  RESET: 'x-ratelimit-reset',
  CONC_LIMIT: 'x-ratelimit-concurrency-limit',
  CONC_CURRENT: 'x-ratelimit-concurrency-current',
  RETRY_AFTER: 'retry-after',
} as const;

beforeEach(() => {
  scripts.current = null;
  inflightBroker.reset();
  __resetPresetAvailabilityCache();
});

// ---------------------------------------------------------------------------
// OSS pass-through (empty api_keys table)
// ---------------------------------------------------------------------------

describe('OSS pass-through — empty api_keys', () => {
  it('emits no X-RateLimit-* headers and never rejects', async () => {
    const { app } = makeApp();
    const res = await app.request('/presets');
    expect(res.status).toBe(200);
    expect(res.headers.get(RATE_HEADERS.TIER)).toBeNull();
    expect(res.headers.get(RATE_HEADERS.LIMIT)).toBeNull();
    expect(res.headers.get(RATE_HEADERS.CONC_LIMIT)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Authenticated GET — header projection on every response
// ---------------------------------------------------------------------------

describe('Authenticated GET — header projection', () => {
  it('emits all six X-RateLimit-* headers on a 200 GET for a Pro account', async () => {
    const counter: EnvelopeCounter = { count: () => 12 };
    const { db, app } = makeApp({ counter });
    provisionAccount(db, 'acct_pro', 'pro');
    const issued = await createApiKey(db, {
      keyType: 'live',
      argon: FAST_ARGON,
      accountId: 'acct_pro',
    });

    const res = await app.request('/presets', {
      headers: { Authorization: `Bearer ${issued.secret}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get(RATE_HEADERS.TIER)).toBe('pro');
    // GET path doesn't consume envelope, so Limit shows the ceiling but
    // Remaining mirrors it (since the count wasn't fetched).
    expect(res.headers.get(RATE_HEADERS.LIMIT)).toBe('350');
    expect(res.headers.get(RATE_HEADERS.REMAINING)).toBe('350');
    expect(res.headers.get(RATE_HEADERS.RESET)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(res.headers.get(RATE_HEADERS.CONC_LIMIT)).toBe('1');
    expect(res.headers.get(RATE_HEADERS.CONC_CURRENT)).toBe('0');
  });

  it('emits null-limit headers on an enterprise (unlimited) account', async () => {
    const { db, app } = makeApp();
    provisionAccount(db, 'acct_ent', 'enterprise');
    const issued = await createApiKey(db, {
      keyType: 'live',
      argon: FAST_ARGON,
      accountId: 'acct_ent',
    });
    const res = await app.request('/presets', {
      headers: { Authorization: `Bearer ${issued.secret}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get(RATE_HEADERS.TIER)).toBe('enterprise');
    // Unlimited limits are not emitted (header omitted when null).
    expect(res.headers.get(RATE_HEADERS.LIMIT)).toBeNull();
    expect(res.headers.get(RATE_HEADERS.CONC_LIMIT)).toBeNull();
    // Reset is still emitted so clients have a parseable wall-clock anchor.
    expect(res.headers.get(RATE_HEADERS.RESET)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// ---------------------------------------------------------------------------
// Test-key bypass (PAR-33 keyType === 'test')
// ---------------------------------------------------------------------------

describe('Test-key bypass', () => {
  it("doesn't apply the limiter to test keys (keyThrottle owns them)", async () => {
    const counter: EnvelopeCounter = {
      count: () => 999_999, // would 429 a live key instantly
    };
    const { db, app } = makeApp({ counter });
    provisionAccount(db, 'acct_pro', 'pro');
    const issued = await createApiKey(db, {
      keyType: 'test',
      argon: FAST_ARGON,
      accountId: 'acct_pro',
    });
    const res = await app.request('/presets', {
      headers: { Authorization: `Bearer ${issued.secret}` },
    });
    expect(res.status).toBe(200);
    // No headers — bypass is total.
    expect(res.headers.get(RATE_HEADERS.TIER)).toBeNull();
    expect(res.headers.get(RATE_HEADERS.LIMIT)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Burst exhaustion → 429 rate_limited
// ---------------------------------------------------------------------------

describe('Burst limit (10 RPS for paid tiers)', () => {
  it('returns 429 rate_limited with Retry-After when the bucket is empty', async () => {
    const counter: EnvelopeCounter = { count: () => 0 };
    const clock = fixedClock(1_700_000_000_000);
    const limited: Array<{ kind: string; accountId: string }> = [];
    const { db, app } = makeApp({
      counter,
      now: clock.now,
      onLimited: (kind, accountId) => limited.push({ kind, accountId }),
    });
    provisionAccount(db, 'acct_pro', 'pro');
    const issued = await createApiKey(db, {
      keyType: 'live',
      argon: FAST_ARGON,
      accountId: 'acct_pro',
    });

    // Burn the 10-token bucket on cheap GETs.
    for (let i = 0; i < 10; i += 1) {
      const r = await app.request('/presets', {
        headers: { Authorization: `Bearer ${issued.secret}` },
      });
      expect(r.status).toBe(200);
    }
    const blocked = await app.request('/presets', {
      headers: { Authorization: `Bearer ${issued.secret}` },
    });
    expect(blocked.status).toBe(429);
    const body = (await blocked.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('rate_limited');
    expect(blocked.headers.get(RATE_HEADERS.RETRY_AFTER)).toBe('1');
    // Headers still present on the 429.
    expect(blocked.headers.get(RATE_HEADERS.TIER)).toBe('pro');
    expect(blocked.headers.get(RATE_HEADERS.LIMIT)).toBe('350');
    expect(limited).toEqual([{ kind: 'rate_limited', accountId: 'acct_pro' }]);
  });
});

// ---------------------------------------------------------------------------
// Envelope exhaustion → 429 usage_limit_exceeded
// ---------------------------------------------------------------------------

describe('Envelope limit', () => {
  it('returns 429 usage_limit_exceeded on a POST when the count is at the ceiling', async () => {
    const counter: EnvelopeCounter = { count: () => 350 };
    const limited: Array<{ kind: string }> = [];
    const { db, app } = makeApp({ counter, onLimited: (kind) => limited.push({ kind }) });
    provisionAccount(db, 'acct_pro', 'pro');
    const issued = await createApiKey(db, {
      keyType: 'live',
      argon: FAST_ARGON,
      accountId: 'acct_pro',
    });

    scripts.current = { result: baseResult() };
    const res = await app.request('/deliberate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${issued.secret}`,
      },
      body: JSON.stringify({ topic: 'over the cap' }),
    });
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('usage_limit_exceeded');
    expect(res.headers.get(RATE_HEADERS.LIMIT)).toBe('350');
    expect(res.headers.get(RATE_HEADERS.REMAINING)).toBe('0');
    expect(limited).toEqual([{ kind: 'usage_limit_exceeded' }]);
  });

  it('does not consume the envelope on GET requests', async () => {
    let reads = 0;
    const counter: EnvelopeCounter = {
      count() {
        reads += 1;
        return 0;
      },
    };
    const { db, app } = makeApp({ counter });
    provisionAccount(db, 'acct_pro', 'pro');
    const issued = await createApiKey(db, {
      keyType: 'live',
      argon: FAST_ARGON,
      accountId: 'acct_pro',
    });

    for (let i = 0; i < 3; i += 1) {
      const r = await app.request('/presets', {
        headers: { Authorization: `Bearer ${issued.secret}` },
      });
      expect(r.status).toBe(200);
    }
    expect(reads).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Concurrency cap → 409 concurrency_exceeded
// ---------------------------------------------------------------------------

describe('Concurrency cap', () => {
  it('returns 409 concurrency_exceeded when a Pro account already has one in-flight POST', async () => {
    const counter: EnvelopeCounter = { count: () => 0 };
    const limited: Array<{ kind: string }> = [];
    const { db, app } = makeApp({ counter, onLimited: (kind) => limited.push({ kind }) });
    provisionAccount(db, 'acct_pro', 'pro');
    const issued = await createApiKey(db, {
      keyType: 'live',
      argon: FAST_ARGON,
      accountId: 'acct_pro',
    });

    // Hold the engine open so the first POST stays in-flight.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    scripts.current = { hold: () => gate, result: baseResult() };

    const first = await app.request('/deliberate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${issued.secret}`,
      },
      body: JSON.stringify({ topic: 'first' }),
    });
    expect(first.status).toBe(202);

    // Yield to the engine mock so the in-flight increment has landed.
    await new Promise((r) => setImmediate(r));

    const second = await app.request('/deliberate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${issued.secret}`,
      },
      body: JSON.stringify({ topic: 'second' }),
    });
    expect(second.status).toBe(409);
    const body = (await second.json()) as { error: { code: string } };
    expect(body.error.code).toBe('concurrency_exceeded');
    expect(second.headers.get(RATE_HEADERS.CONC_LIMIT)).toBe('1');
    expect(second.headers.get(RATE_HEADERS.CONC_CURRENT)).toBe('1');
    expect(limited).toEqual([{ kind: 'concurrency_exceeded' }]);

    // Drain the held engine so the test exits cleanly.
    release();
    await new Promise((r) => setImmediate(r));
  });
});

// ---------------------------------------------------------------------------
// Fail-open behaviour
// ---------------------------------------------------------------------------

describe('Fail-open default', () => {
  it('admits the request when the counter throws (logged via console.warn)', async () => {
    const counter: EnvelopeCounter = {
      count() {
        throw new Error('db is on fire');
      },
    };
    const { db, app } = makeApp({ counter });
    provisionAccount(db, 'acct_pro', 'pro');
    const issued = await createApiKey(db, {
      keyType: 'live',
      argon: FAST_ARGON,
      accountId: 'acct_pro',
    });
    scripts.current = { result: baseResult() };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await app.request('/deliberate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${issued.secret}`,
      },
      body: JSON.stringify({ topic: 'fail-open' }),
    });
    expect(res.status).toBe(202);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    await new Promise((r) => setImmediate(r));
  });
});

// ---------------------------------------------------------------------------
// Account-row missing — defensive bypass
// ---------------------------------------------------------------------------

describe('Account row missing', () => {
  it('falls back to pass-through when bearerAuth references an unknown account', async () => {
    // Simulate a stale FK by issuing under a real account, then dropping
    // foreign_keys briefly so we can delete the row. This models prod
    // states like a manually-deleted account row leaving an orphan key —
    // the limiter must not 500 on this.
    const { db, app } = makeApp();
    provisionAccount(db, 'acct_ghost', 'pro');
    const issued = await createApiKey(db, {
      keyType: 'live',
      argon: FAST_ARGON,
      accountId: 'acct_ghost',
    });
    db.exec('PRAGMA foreign_keys = OFF');
    db.prepare(`DELETE FROM accounts WHERE id = ?`).run('acct_ghost');
    db.exec('PRAGMA foreign_keys = ON');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await app.request('/presets', {
      headers: { Authorization: `Bearer ${issued.secret}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get(RATE_HEADERS.TIER)).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
