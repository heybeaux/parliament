import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DeliberationResult } from '@parliament/core';

/**
 * Stage 4 task `a3aa8255` — server contract: enrich turn records and add
 * `events[]`. The server response is what the Stage 3 Observability UI
 * consumes; this suite pins the four ACs:
 *
 *   AC1 — `model_name`, `neurotype_posture`, `word_count`, `convergence_delta`
 *         appear on every turn record.
 *   AC2 — `convergence_delta` is null on round 1, numeric on round > 1.
 *   AC3 — `events[]` is populated from RedAgent + Sentry events.
 *   AC4 — Backward compat: an old client schema (no awareness of the new
 *         fields) parses a new response without error.
 *
 * PAR-18 — `POST /deliberate` no longer returns the enriched body inline;
 * the route mints an id, persists a placeholder row with `status: 'in_flight'`,
 * and returns `{id, status}` in 202. Enrichment runs on the GET path
 * (`GET /deliberate/:id`). This suite drives the GET path directly: we set
 * `mockGetDeliberation` to return a fully-formed result and assert that the
 * router enriches it into the expected wire shape.
 */

// `vi.hoisted` guarantees these refs exist before vi.mock factories run.
const hoisted = vi.hoisted(() => ({
  mockSaveDeliberation: vi.fn(),
  mockGetDeliberation: vi.fn(),
  mockListDeliberations: vi.fn().mockReturnValue([]),
  mockCreateDeliberationRow: vi.fn(),
  mockAppendTurn: vi.fn(),
  mockAppendEvent: vi.fn(),
  mockMarkCompleted: vi.fn(),
  mockMarkFailed: vi.fn(),
}));

vi.mock('../db.js', () => ({
  initDb: vi.fn().mockReturnValue({}),
  saveDeliberation: (...args: unknown[]) => hoisted.mockSaveDeliberation(...args),
  getDeliberation: (...args: unknown[]) => hoisted.mockGetDeliberation(...args),
  listDeliberations: (...args: unknown[]) => hoisted.mockListDeliberations(...args),
  createDeliberationRow: (...args: unknown[]) => hoisted.mockCreateDeliberationRow(...args),
  appendTurn: (...args: unknown[]) => hoisted.mockAppendTurn(...args),
  appendEvent: (...args: unknown[]) => hoisted.mockAppendEvent(...args),
  markCompleted: (...args: unknown[]) => hoisted.mockMarkCompleted(...args),
  markFailed: (...args: unknown[]) => hoisted.mockMarkFailed(...args),
}));

vi.mock('@parliament/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@parliament/core')>();

  // Engine isn't directly used by the GET path, but we keep the mock so any
  // POST-path test (or future addition) doesn't accidentally hit a real
  // adapter.
  const MockDeliberationEngine = vi.fn().mockImplementation(() => ({
    run: vi.fn().mockResolvedValue(null),
    runTopology: vi.fn().mockResolvedValue(null),
  }));

  const baseTopology = {
    activePreset: actual.BUILTIN_PRESETS['debate']!,
    presets: { ...actual.BUILTIN_PRESETS },
    userNeurotypes: {},
  };

  return {
    ...actual,
    DeliberationEngine: MockDeliberationEngine,
    loadTopologyConfig: vi.fn().mockReturnValue(baseTopology),
    loadConfig: vi.fn().mockReturnValue({
      neurotypes: {
        proposer: { model: 'mock', system_prompt: 'You are a proposer.' },
        skeptic: { model: 'mock', system_prompt: 'You are a skeptic.' },
        synthesizer: { model: 'mock', system_prompt: 'You are a synthesizer.' },
        redAgent: { model: 'mock', system_prompt: 'You are a red agent.' },
        sentry: { model: 'mock', system_prompt: 'You are a sentry.' },
      },
    }),
    createAdapter: vi.fn().mockReturnValue({
      modelName: 'mock-model',
      generate: vi.fn().mockResolvedValue({ content: 'mock response' }),
    }),
    buildAgentsFromConfig: vi.fn().mockReturnValue([
      { name: 'proposer', neurotype: 'proposer', model: 'mock', adapter: { generate: vi.fn().mockResolvedValue({ content: 'ok' }) }, systemPrompt: '' },
      { name: 'skeptic', neurotype: 'skeptic', model: 'mock', adapter: { generate: vi.fn().mockResolvedValue({ content: 'ok' }) }, systemPrompt: '' },
      { name: 'synthesizer', neurotype: 'synthesizer', model: 'mock', adapter: { generate: vi.fn().mockResolvedValue({ content: 'ok' }) }, systemPrompt: '' },
      { name: 'redAgent', neurotype: 'redAgent', model: 'mock', adapter: { generate: vi.fn().mockResolvedValue({ content: 'ok' }) }, systemPrompt: '' },
      { name: 'sentry', neurotype: 'sentry', model: 'mock', adapter: { generate: vi.fn().mockResolvedValue({ content: 'ok' }) }, systemPrompt: '' },
    ]),
    ProposerAgent: vi.fn().mockImplementation(() => ({ role: 'Proposer', neurotype: 'p', generate: vi.fn() })),
    SkepticAgent: vi.fn().mockImplementation(() => ({ role: 'Skeptic', neurotype: 's', generate: vi.fn() })),
    SynthesizerAgent: vi.fn().mockImplementation(() => ({ role: 'Synthesizer', neurotype: 'i', generate: vi.fn() })),
    RedAgent: vi.fn().mockImplementation(() => ({ role: 'RedAgent', neurotype: 'r', generate: vi.fn() })),
    SentryAgent: vi.fn().mockImplementation(() => ({ role: 'Sentry', neurotype: 'm', generate: vi.fn() })),
    ModelConnectionError: actual.ModelConnectionError,
  };
});

import { createRouter } from '../routes.js';

function makeApp() {
  const fakeDb = {} as import('better-sqlite3').Database;
  return createRouter(fakeDb);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function turn(opts: {
  agent: string;
  neurotype: string;
  model: string;
  content: string;
  round: number;
  word_count?: number;
  meta?: Record<string, unknown>;
}) {
  const t: DeliberationResult['turns'][number] = {
    agent: opts.agent,
    neurotype: opts.neurotype,
    model: opts.model,
    content: opts.content,
    timestamp: '2026-01-01T00:00:00.000Z',
    round: opts.round,
  };
  if (opts.word_count !== undefined) t.word_count = opts.word_count;
  if (opts.meta !== undefined) t.meta = opts.meta as DeliberationResult['turns'][number]['meta'];
  return t;
}

function baseResult(over: Partial<DeliberationResult>): DeliberationResult {
  return {
    topic: 'test',
    turns: [],
    conflicts: [],
    residueScore: 0,
    resolved: true,
    synthesis: 'final',
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

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.mockSaveDeliberation.mockReturnValue(undefined);
});

// ---------------------------------------------------------------------------
// AC1 — turn records expose all four enrichment fields
// ---------------------------------------------------------------------------

describe('AC1 — turn record schema includes the four enrichment fields', () => {
  it('every GET /deliberate/:id turn carries model_name, neurotype_posture, word_count, convergence_delta', async () => {
    hoisted.mockGetDeliberation.mockReturnValue(
      baseResult({
        turns: [
          turn({
            agent: 'Proposer',
            neurotype: 'epistemic/evidence-first',
            model: 'qwen3:8b',
            content: 'one two three four',
            round: 1,
            word_count: 4,
          }),
        ],
      }),
    );

    const app = makeApp();
    const res = await app.request('/deliberate/some-id');
    expect(res.status).toBe(200);

    const body = (await res.json()) as { turns: Array<Record<string, unknown>> };
    expect(body.turns).toHaveLength(1);

    const t = body.turns[0]!;
    expect(t['model_name']).toBe('qwen3:8b');
    expect(t['neurotype_posture']).toBe('epistemic/evidence-first');
    expect(t['word_count']).toBe(4);
    expect('convergence_delta' in t).toBe(true);

    // The original fields MUST still be present (additive contract).
    expect(t['agent']).toBe('Proposer');
    expect(t['neurotype']).toBe('epistemic/evidence-first');
    expect(t['model']).toBe('qwen3:8b');
    expect(t['content']).toBe('one two three four');
    expect(t['round']).toBe(1);
  });

  it('falls back to recomputing word_count when the stored turn predates Stage 3', async () => {
    hoisted.mockGetDeliberation.mockReturnValue(
      baseResult({
        turns: [
          turn({
            agent: 'Proposer',
            neurotype: 'structured',
            model: 'm',
            content: 'alpha beta gamma',
            round: 1,
            // word_count intentionally omitted — older transcripts
          }),
        ],
      }),
    );

    const app = makeApp();
    const res = await app.request('/deliberate/some-id');
    expect(res.status).toBe(200);

    const body = (await res.json()) as { turns: Array<{ word_count: number }> };
    expect(body.turns[0]!.word_count).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// AC2 — convergence_delta semantics
// ---------------------------------------------------------------------------

describe('AC2 — convergence_delta is null on round 1, numeric on round > 1', () => {
  it('round-1 turn → convergence_delta is null', async () => {
    hoisted.mockGetDeliberation.mockReturnValue(
      baseResult({
        turns: [
          turn({ agent: 'Proposer', neurotype: 'p', model: 'm', content: 'x', round: 1 }),
        ],
      }),
    );

    const app = makeApp();
    const res = await app.request('/deliberate/some-id');
    expect(res.status).toBe(200);

    const body = (await res.json()) as { turns: Array<{ convergence_delta: number | null }> };
    expect(body.turns[0]!.convergence_delta).toBeNull();
  });

  it('round-2+ turns → numeric convergence_delta computed from prior synth confidence', async () => {
    hoisted.mockGetDeliberation.mockReturnValue(
      baseResult({
        totalRounds: 3,
        turns: [
          turn({ agent: 'Skeptic', neurotype: 'critical', model: 'm', content: 'a', round: 1 }),
          turn({
            agent: 'Synthesizer',
            neurotype: 'integrative',
            model: 'm',
            content: 's1',
            round: 1,
            meta: { confidence: 0.4, consensus: false, agreed: [], unresolved: [] },
          }),
          turn({ agent: 'Skeptic', neurotype: 'critical', model: 'm', content: 'b', round: 2 }),
          turn({
            agent: 'Synthesizer',
            neurotype: 'integrative',
            model: 'm',
            content: 's2',
            round: 2,
            meta: { confidence: 0.7, consensus: false, agreed: [], unresolved: [] },
          }),
          turn({ agent: 'Skeptic', neurotype: 'critical', model: 'm', content: 'c', round: 3 }),
        ],
      }),
    );

    const app = makeApp();
    const res = await app.request('/deliberate/some-id');
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      turns: Array<{ round: number; agent: string; convergence_delta: number | null }>;
    };

    // Round 1 — null
    const r1 = body.turns.filter((t) => t.round === 1);
    for (const t of r1) expect(t.convergence_delta).toBeNull();

    // Round 2 — synth(1) - 0 = 0.4
    const r2 = body.turns.filter((t) => t.round === 2);
    for (const t of r2) expect(t.convergence_delta).toBeCloseTo(0.4, 4);

    // Round 3 — synth(2) - synth(1) = 0.3
    const r3 = body.turns.filter((t) => t.round === 3);
    for (const t of r3) expect(t.convergence_delta).toBeCloseTo(0.3, 4);
  });
});

// ---------------------------------------------------------------------------
// AC3 — events[] populated from RedAgent + Sentry signals
// ---------------------------------------------------------------------------

describe('AC3 — events[] surfaces RedAgent injections and Sentry warnings', () => {
  it('passes through stored events on GET /deliberate/:id', async () => {
    hoisted.mockGetDeliberation.mockReturnValue(
      baseResult({
        events: [
          { round: 3, kind: 'red_agent.injection', message: 'a disruptive thought' },
          { round: 4, kind: 'sentry.echo', message: 'echo collapse detected' },
        ],
      }),
    );

    const app = makeApp();
    const res = await app.request('/deliberate/some-id');
    expect(res.status).toBe(200);

    const body = (await res.json()) as { events: Array<{ round: number; kind: string; message: string }> };
    expect(body.events).toHaveLength(2);
    expect(body.events[0]).toEqual({
      round: 3,
      kind: 'red_agent.injection',
      message: 'a disruptive thought',
    });
    expect(body.events[1]).toEqual({
      round: 4,
      kind: 'sentry.echo',
      message: 'echo collapse detected',
    });
  });

  it('returns events: [] when no events fired', async () => {
    hoisted.mockGetDeliberation.mockReturnValue(baseResult({ events: [] }));

    const app = makeApp();
    const res = await app.request('/deliberate/some-id');
    expect(res.status).toBe(200);

    const body = (await res.json()) as { events: unknown[] };
    expect(Array.isArray(body.events)).toBe(true);
    expect(body.events).toHaveLength(0);
  });

  it('GET /deliberate/:id tolerates legacy stored rows that lack events', async () => {
    // Simulate a pre-Stage-4 row by deleting events post-construction.
    const stored = baseResult({});
    delete (stored as Partial<DeliberationResult>).events;
    hoisted.mockGetDeliberation.mockReturnValue(stored as DeliberationResult);

    const app = makeApp();
    const res = await app.request('/deliberate/legacy-id');
    expect(res.status).toBe(200);

    const body = (await res.json()) as { events: unknown[] };
    expect(Array.isArray(body.events)).toBe(true);
    expect(body.events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC4 — backward compat
// ---------------------------------------------------------------------------

describe('AC4 — old client schemas parse new responses', () => {
  it('a legacy client that only knows about agent/neurotype/model/content/round still parses cleanly', async () => {
    hoisted.mockGetDeliberation.mockReturnValue(
      baseResult({
        turns: [
          turn({ agent: 'Proposer', neurotype: 'p', model: 'm', content: 'hi', round: 1 }),
        ],
      }),
    );

    const app = makeApp();
    const res = await app.request('/deliberate/some-id');
    expect(res.status).toBe(200);

    const body = await res.json();

    // A legacy client would discriminate on the original field set only.
    // Simulating its narrow projection MUST succeed without throwing.
    const legacyView = (body as { turns: Array<Record<string, unknown>> }).turns.map((t) => ({
      agent: t['agent'] as string,
      neurotype: t['neurotype'] as string,
      model: t['model'] as string,
      content: t['content'] as string,
      round: t['round'] as number,
    }));

    expect(legacyView).toHaveLength(1);
    expect(legacyView[0]!.agent).toBe('Proposer');
    expect(legacyView[0]!.model).toBe('m');
    expect(legacyView[0]!.round).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// PAR-23 — adapter-meta round-trip on GET /deliberate/:id
// ---------------------------------------------------------------------------

describe('PAR-23 — adapter telemetry survives the persistence round-trip', () => {
  it('GET /deliberate/:id passes turn.meta (latency, tokens, cost, provider) through verbatim', async () => {
    hoisted.mockGetDeliberation.mockReturnValue(
      baseResult({
        turns: [
          turn({
            agent: 'Proposer',
            neurotype: 'p',
            model: 'anthropic/claude-3.5-sonnet',
            content: 'hello',
            round: 1,
            meta: {
              latencyMs: 1234,
              promptTokens: 11,
              completionTokens: 22,
              costUsd: 0.0042,
              generationId: 'gen_abc123',
              provider: 'openrouter',
            },
          }),
          turn({
            agent: 'Synthesizer',
            neurotype: 'integrative',
            model: 'mock',
            content: 's',
            round: 1,
            meta: {
              // Synthesizer turn carries BOTH adapter telemetry and the
              // synthesizer's own structured fields. The merged shape must
              // round-trip cleanly.
              latencyMs: 800,
              promptTokens: 30,
              completionTokens: 60,
              provider: 'ollama',
              confidence: 0.6,
              consensus: false,
              agreed: ['x'],
              unresolved: ['y'],
            },
          }),
        ],
      }),
    );

    const app = makeApp();
    const res = await app.request('/deliberate/par23-id');
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      turns: Array<Record<string, unknown>>;
    };

    // Adapter-only meta on the proposer turn.
    const proposer = body.turns[0]!;
    expect(proposer['meta']).toEqual({
      latencyMs: 1234,
      promptTokens: 11,
      completionTokens: 22,
      costUsd: 0.0042,
      generationId: 'gen_abc123',
      provider: 'openrouter',
    });

    // Merged adapter + synthesizer meta on the synth turn — additive.
    const synth = body.turns[1]!;
    expect(synth['meta']).toMatchObject({
      latencyMs: 800,
      promptTokens: 30,
      completionTokens: 60,
      provider: 'ollama',
      confidence: 0.6,
      consensus: false,
      agreed: ['x'],
      unresolved: ['y'],
    });
  });

  it('GET /deliberate/:id tolerates a turn with no meta field at all (legacy rows)', async () => {
    hoisted.mockGetDeliberation.mockReturnValue(
      baseResult({
        turns: [
          turn({ agent: 'Proposer', neurotype: 'p', model: 'm', content: 'x', round: 1 }),
        ],
      }),
    );

    const app = makeApp();
    const res = await app.request('/deliberate/legacy-meta');
    expect(res.status).toBe(200);

    const body = (await res.json()) as { turns: Array<Record<string, unknown>> };
    // No meta field is fine — the response shape stays valid.
    expect(body.turns).toHaveLength(1);
  });
});
