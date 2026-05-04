/**
 * PAR-18 — In-flight deliberation reads.
 *
 * Pins the wire-shape and progressive-read contract:
 *   AC1 — POST /deliberate returns 202 with `{id, status: 'in_flight'}`.
 *   AC2 — GET /deliberate/:id during a live run returns `status: 'in_flight'`
 *         and a turns array that grows as the engine emits onTurn callbacks.
 *   AC3 — GET /deliberate/:id after completion returns `status: 'completed'`
 *         exactly once with the final transcript.
 *   AC4 — GET /deliberate/:id/stream replays persisted turns/events on
 *         connect, then forwards live broker pushes, and emits a terminal
 *         `status` event before closing.
 *   AC5 — A failed background run flips `status` to `'failed'` with the
 *         error message intact.
 *
 * These tests use the real db + real broker + real router — only the
 * @parliament/core engine is mocked so we can drive deterministic onTurn
 * callbacks without an Ollama dependency.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DeliberationResult, SystemEvent, Turn } from '@parliament/core';
import { Hono } from 'hono';
import { initDb } from '../db.js';
import { inflightBroker } from '../inflight.js';
import type { RouterVariables } from '../routes.js';

// ---------------------------------------------------------------------------
// Engine mock — exposes a controllable onTurn/onEvent fan-out so each test
// can drive partial-then-complete progress.
// ---------------------------------------------------------------------------

interface ScriptedRun {
  // Caller-supplied steps, replayed in order before the engine resolves.
  turns?: Turn[];
  events?: SystemEvent[];
  // Final result the engine resolves with. If absent, the engine throws.
  result?: DeliberationResult;
  error?: Error;
  // Optional gate so a test can hold the engine open until it's ready
  // to observe the in-flight state. Default: resolves immediately.
  hold?: () => Promise<void>;
}

const scripts: { current: ScriptedRun | null } = { current: null };

vi.mock('@parliament/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@parliament/core')>();

  const MockEngine = vi.fn().mockImplementation(() => ({
    runTopology: vi.fn().mockImplementation(
      async (
        _topic: string,
        config: {
          onTurn?: (turn: Turn) => void;
          onEvent?: (event: SystemEvent) => void;
        },
      ) => {
        const script = scripts.current;
        if (script === null) {
          throw new Error('engine mock: no script set');
        }
        for (const turn of script.turns ?? []) {
          config.onTurn?.(turn);
        }
        for (const event of script.events ?? []) {
          config.onEvent?.(event);
        }
        if (script.hold !== undefined) {
          await script.hold();
        }
        if (script.error !== undefined) {
          throw script.error;
        }
        if (script.result === undefined) {
          throw new Error('engine mock: script has neither result nor error');
        }
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

const { createRouter } = await import('../routes.js');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeApp(): { app: Hono<RouterVariables>; db: ReturnType<typeof initDb> } {
  const db = initDb(':memory:');
  const app = createRouter(db);
  return { app, db };
}

function turn(round: number, agent = 'Proposer', content = 'turn content'): Turn {
  return {
    agent,
    neurotype: agent.toLowerCase(),
    model: 'mock-model',
    content,
    timestamp: '2026-01-01T00:00:00.000Z',
    round,
  };
}

function baseResult(over: Partial<DeliberationResult> = {}): DeliberationResult {
  return {
    topic: 'inflight test',
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

beforeEach(() => {
  scripts.current = null;
  inflightBroker.reset();
});

// ---------------------------------------------------------------------------
// AC1 — mint-on-submit
// ---------------------------------------------------------------------------

describe('PAR-18 AC1 — POST /deliberate returns 202 + {id, status: in_flight}', () => {
  it('returns 202 immediately with the minted id and in-flight status', async () => {
    const { app } = makeApp();
    scripts.current = { result: baseResult() };

    const res = await app.request('/deliberate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: 'mint test' }),
    });

    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body['id']).toBe('string');
    expect((body['id'] as string).length).toBeGreaterThan(0);
    expect(body['status']).toBe('in_flight');
    // Drain so the engine mock settles before the test ends.
    await new Promise((r) => setImmediate(r));
  });
});

// ---------------------------------------------------------------------------
// AC2 — progressive turn reads
// ---------------------------------------------------------------------------

describe('PAR-18 AC2 — GET /deliberate/:id grows turns during a live run', () => {
  it("an in-flight deliberation's turn count grows on subsequent GETs", async () => {
    const { app } = makeApp();

    // Hold the engine open so we can observe the in-flight state. We
    // resolve the gate from the outside after the assertions land.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    scripts.current = {
      turns: [turn(1, 'Proposer', 'first turn')],
      hold: () => gate,
      result: baseResult({
        turns: [
          turn(1, 'Proposer', 'first turn'),
          turn(2, 'Skeptic', 'second turn'),
        ],
        totalRounds: 2,
      }),
    };

    const post = await app.request('/deliberate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: 'progressive' }),
    });
    expect(post.status).toBe(202);
    const id = ((await post.json()) as Record<string, string>)['id']!;

    // Yield so the engine's synchronous onTurn pushes have landed on the
    // row before we read it. The mock's runTopology is async because of
    // the hold gate, so a single tick is enough.
    await new Promise((r) => setImmediate(r));

    const inFlight = await app.request(`/deliberate/${id}`);
    expect(inFlight.status).toBe(200);
    const inFlightBody = (await inFlight.json()) as {
      status: string;
      turns: unknown[];
    };
    expect(inFlightBody.status).toBe('in_flight');
    expect(inFlightBody.turns).toHaveLength(1);

    // Release the engine so it resolves with the full transcript.
    release();
    // Drain microtasks so markCompleted lands.
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));

    const completed = await app.request(`/deliberate/${id}`);
    expect(completed.status).toBe(200);
    const completedBody = (await completed.json()) as {
      status: string;
      turns: unknown[];
    };
    expect(completedBody.status).toBe('completed');
    expect(completedBody.turns).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// AC3 — terminal completion
// ---------------------------------------------------------------------------

describe('PAR-18 AC3 — GET /deliberate/:id surfaces a single terminal completed status', () => {
  it('flips to status: completed exactly once and stays there on repeat reads', async () => {
    const { app } = makeApp();
    scripts.current = {
      result: baseResult({
        turns: [turn(1, 'Proposer'), turn(1, 'Skeptic')],
        totalRounds: 1,
      }),
    };

    const post = await app.request('/deliberate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: 'terminal' }),
    });
    const id = ((await post.json()) as Record<string, string>)['id']!;

    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));

    const a = await app.request(`/deliberate/${id}`);
    const b = await app.request(`/deliberate/${id}`);
    const aBody = (await a.json()) as { status: string };
    const bBody = (await b.json()) as { status: string };
    expect(aBody.status).toBe('completed');
    expect(bBody.status).toBe('completed');
  });
});

// ---------------------------------------------------------------------------
// AC4 — SSE replay + live forward + terminal status
// ---------------------------------------------------------------------------

describe('PAR-18 AC4 — GET /deliberate/:id/stream replays then forwards then closes', () => {
  it('replays persisted turns and emits a terminal status when the run has already completed', async () => {
    const { app } = makeApp();
    scripts.current = {
      result: baseResult({
        turns: [turn(1, 'Proposer', 'replay 1'), turn(1, 'Skeptic', 'replay 2')],
        events: [{ round: 1, kind: 'red_agent.injection', message: 'hi' }],
      }),
    };

    const post = await app.request('/deliberate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: 'sse-replay' }),
    });
    const id = ((await post.json()) as Record<string, string>)['id']!;

    // Wait for completion.
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));

    const stream = await app.request(`/deliberate/${id}/stream`);
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toMatch(/text\/event-stream/);

    const text = await stream.text();
    // Two turn replays + one event replay + one terminal status.
    const turnFrames = text.match(/^event: turn$/gm) ?? [];
    const eventFrames = text.match(/^event: system_event$/gm) ?? [];
    const statusFrames = text.match(/^event: status$/gm) ?? [];
    expect(turnFrames).toHaveLength(2);
    expect(eventFrames).toHaveLength(1);
    expect(statusFrames).toHaveLength(1);
    expect(text).toContain('"status":"completed"');
    expect(text).toContain('replay 1');
    expect(text).toContain('replay 2');
  });
});

// ---------------------------------------------------------------------------
// AC5 — failure path
// ---------------------------------------------------------------------------

describe('PAR-18 AC5 — engine throws → status: failed with error', () => {
  it('background run failure flips status to failed and stamps the error message', async () => {
    const { app } = makeApp();
    scripts.current = {
      error: new Error('engine exploded mid-run'),
    };

    const post = await app.request('/deliberate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: 'fail path' }),
    });
    expect(post.status).toBe(202);
    const id = ((await post.json()) as Record<string, string>)['id']!;

    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));

    const get = await app.request(`/deliberate/${id}`);
    const body = (await get.json()) as { status: string; error?: string };
    expect(body.status).toBe('failed');
    expect(body.error).toBe('engine exploded mid-run');
  });
});
