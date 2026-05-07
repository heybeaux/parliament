/**
 * Integration tests — exercise the full Parliament stack end-to-end.
 *
 * Uses real DeliberationEngine, real agent classes, real Hono router, and a
 * real in-memory SQLite database. Only the LLM call (ModelAdapter.generate) is
 * stubbed via vi.fn() so we can drive deterministic agent responses without an
 * Ollama server. This covers the boundary between core, server, and SQLite.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import {
  DeliberationEngine,
  ProposerAgent,
  SkepticAgent,
  SynthesizerAgent,
  RedAgent,
  SentryAgent,
  computeOSI,
  detectEchoLoop,
} from '@parliament/core';
import type { ModelAdapter, DeliberationConfig } from '@parliament/core';
import { initDb, saveDeliberation, getDeliberation } from '../db.js';
import type { RouterVariables } from '../routes.js';

// ---------------------------------------------------------------------------
// Stubbed LLM adapter — drives agent output deterministically per role.
// ---------------------------------------------------------------------------

interface RoleScripts {
  proposer: string[];
  skeptic: string[];
  synthesizer: string[];
  redAgent: string[];
  sentry: string[];
}

function makeAdapter(role: keyof RoleScripts, scripts: RoleScripts): ModelAdapter {
  let i = 0;
  return {
    modelName: `test-${role}`,
    generate: vi.fn(async () => {
      const list = scripts[role];
      const value = list[Math.min(i, list.length - 1)] ?? '';
      i++;
      return { content: value };
    }),
  };
}

function buildAgents(scripts: RoleScripts): DeliberationConfig['agents'] {
  return {
    proposer: new ProposerAgent(makeAdapter('proposer', scripts)),
    skeptic: new SkepticAgent(makeAdapter('skeptic', scripts)),
    synthesizer: new SynthesizerAgent(makeAdapter('synthesizer', scripts)),
    redAgent: new RedAgent(makeAdapter('redAgent', scripts)),
    sentry: new SentryAgent(makeAdapter('sentry', scripts)),
  };
}

// ---------------------------------------------------------------------------
// End-to-end engine flow — multi-turn debate with real agents.
// ---------------------------------------------------------------------------

describe('end-to-end deliberation', () => {
  it('runs a multi-round debate and returns a transcript with all roles', async () => {
    const scripts: RoleScripts = {
      proposer: ['Renewable energy scales with grid storage and demand response.'],
      skeptic: [
        'Storage at grid scale is unproven economically; the assumption is shaky.',
        'Demand response struggles in industrial loads — scope is overstated.',
      ],
      synthesizer: [
        JSON.stringify({
          summary: 'Grid storage and demand response are complementary.',
          confidence: 0.4,
          consensus: false,
          agreed: ['both reduce peak load'],
          unresolved: ['cost trajectory'],
        }),
        JSON.stringify({
          summary: 'Storage costs are falling; demand response covers residential.',
          confidence: 0.85,
          consensus: true,
          agreed: ['storage scales', 'DR covers residential'],
          unresolved: [],
        }),
      ],
      redAgent: ['What if base-load nuclear is the cheaper path entirely?'],
      sentry: ['OK', 'OK', 'OK'],
    };

    const engine = new DeliberationEngine();
    const result = await engine.run('Energy transition policy', {
      maxRounds: 3,
      redAgentInterval: 99,
      confidenceThreshold: 0.7,
      agents: buildAgents(scripts),
    });

    // Reaches consensus on the second synthesizer call (0.85 ≥ 0.7).
    expect(result.terminationReason).toBe('consensus');
    expect(result.synthesis).toMatch(/Storage costs/);
    expect(result.totalRounds).toBe(2);

    // Transcript carries Proposer, Skeptic, Synthesizer turns in order.
    const roles = result.turns.map((t) => t.agent);
    expect(roles[0]).toBe('Proposer');
    expect(roles).toContain('Skeptic');
    expect(roles).toContain('Synthesizer');
  });

  it('terminates on echo_loop when sentry signals collapse_detected', async () => {
    const scripts: RoleScripts = {
      proposer: ['Initial position.'],
      skeptic: ['Critique of initial position.'],
      synthesizer: [
        JSON.stringify({
          summary: 'Tentative synthesis.',
          confidence: 0.3,
          consensus: false,
          agreed: [],
          unresolved: ['core disagreement'],
        }),
      ],
      redAgent: ['n/a'],
      sentry: ['COLLAPSE_DETECTED'],
    };

    const engine = new DeliberationEngine();
    const result = await engine.run('Echo topic', {
      maxRounds: 5,
      redAgentInterval: 99,
      confidenceThreshold: 0.7,
      agents: buildAgents(scripts),
    });

    expect(result.terminationReason).toBe('echo_loop');
    // On non-consensus termination, engine surfaces the highest-confidence
    // synth attempt as best-effort prose. Script supplies a single tentative
    // summary; that's what gets surfaced.
    expect(result.synthesis).toBe('Tentative synthesis.');
    expect(result.split).not.toBeNull();
  });

  it('OSI calibration detects echo loops in repetitive transcripts', async () => {
    // Synthesizer keeps producing nearly identical content — OSI should converge.
    const repeated = 'We agree there is no clear answer to this difficult question.';
    const scripts: RoleScripts = {
      proposer: ['Opening statement on the topic.'],
      skeptic: ['First critique', 'Second critique', 'Third critique'],
      synthesizer: [
        JSON.stringify({ summary: repeated, confidence: 0.3, consensus: false, agreed: [], unresolved: [] }),
        JSON.stringify({ summary: repeated, confidence: 0.3, consensus: false, agreed: [], unresolved: [] }),
        JSON.stringify({ summary: repeated, confidence: 0.3, consensus: false, agreed: [], unresolved: [] }),
      ],
      redAgent: ['Disruption.'],
      sentry: ['OK', 'OK', 'OK', 'OK', 'OK', 'OK'],
    };

    const engine = new DeliberationEngine();
    const result = await engine.run('Stagnant topic', {
      maxRounds: 3,
      redAgentInterval: 99,
      confidenceThreshold: 0.99, // never reached
      agents: buildAgents(scripts),
    });

    const synthScores = computeOSI(result.turns, 'Synthesizer');
    // First Synthesizer turn → 0; subsequent ones near 0 because content is identical.
    expect(synthScores[0]).toBe(0);
    for (const s of synthScores.slice(1)) {
      expect(s).toBeLessThan(0.15);
    }

    // detectEchoLoop on the synthesizer-only window should fire.
    const synthTurns = result.turns.filter((t) => t.agent === 'Synthesizer');
    expect(detectEchoLoop(synthTurns, 3)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// REST API end-to-end — real router, real DB, stubbed adapters.
// ---------------------------------------------------------------------------

// Mock @parliament/core's loadConfig + createAdapter so the route uses our
// scripted adapters instead of trying to reach Ollama. The agent classes
// themselves are NOT mocked — we exercise the real ProposerAgent etc.
vi.mock('@parliament/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@parliament/core')>();

  const mockScripts: RoleScripts = {
    proposer: ['A reasoned proposal.'],
    skeptic: ['A targeted critique of the proposal.'],
    synthesizer: [
      JSON.stringify({
        summary: 'A unifying synthesis.',
        confidence: 0.9,
        consensus: true,
        agreed: ['unified position'],
        unresolved: [],
      }),
    ],
    redAgent: ['A disruption.'],
    sentry: ['OK', 'OK', 'OK'],
  };

  return {
    ...actual,
    loadConfig: vi.fn().mockReturnValue({
      neurotypes: {
        proposer: { model: 'llama3.2', system_prompt: '' },
        skeptic: { model: 'mistral', system_prompt: '' },
        synthesizer: { model: 'llama3.2', system_prompt: '' },
        redAgent: { model: 'mistral', system_prompt: '' },
        sentry: { model: 'llama3.2', system_prompt: '' },
      },
    }),
    buildAgentsFromConfig: vi.fn().mockImplementation(
      (
        roles: string[] | undefined,
        adapterFactory: (model: string) => ModelAdapter,
      ) => {
        const r = roles ?? ['proposer', 'skeptic', 'synthesizer', 'redAgent', 'sentry'];
        return r.map((role) => ({
          name: role,
          neurotype: role,
          model: 'mock',
          adapter: adapterFactory('mock'),
          systemPrompt: '',
        }));
      },
    ),
    createAdapter: vi.fn().mockImplementation((_model: string) => {
      // The route builds one adapter per agent. We discriminate by the system
      // prompt baked into each agent class so a single factory can drive all
      // five roles deterministically.
      const counts = { proposer: 0, skeptic: 0, synth: 0, red: 0, sentry: 0 };
      return {
        generate: vi.fn(async (_prompt: string, system?: string) => {
          const sys = system ?? '';
          if (/synthesiz/i.test(sys)) {
            return {
              content: mockScripts.synthesizer[counts.synth++ % mockScripts.synthesizer.length] ?? '',
            };
          }
          if (/critic/i.test(sys)) {
            return {
              content: mockScripts.skeptic[counts.skeptic++ % mockScripts.skeptic.length] ?? '',
            };
          }
          if (/disruptor/i.test(sys)) {
            return {
              content: mockScripts.redAgent[counts.red++ % mockScripts.redAgent.length] ?? '',
            };
          }
          if (/monitor/i.test(sys)) {
            return {
              content: mockScripts.sentry[counts.sentry++ % mockScripts.sentry.length] ?? 'OK',
            };
          }
          return {
            content: mockScripts.proposer[counts.proposer++ % mockScripts.proposer.length] ?? '',
          };
        }),
      };
    }),
  };
});

// Re-import createRouter AFTER the mock so it picks up the stubbed deps.
const { createRouter } = await import('../routes.js');

describe('REST API end-to-end (real engine + in-memory SQLite)', () => {
  let app: Hono<RouterVariables>;
  let db: ReturnType<typeof initDb>;

  beforeEach(() => {
    db = initDb(':memory:');
    app = createRouter(db);
  });

  it('POST /deliberate runs a real engine in the background and persists the result (PAR-18)', async () => {
    const res = await app.request('/deliberate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic: 'Should we adopt remote-first culture?',
        config: { maxRounds: 2, confidenceThreshold: 0.7 },
      }),
    });

    // PAR-18: POST returns 202 + {id, status: 'in_flight'} immediately;
    // the engine runs in the background and writes turns/events
    // progressively. We then poll GET /deliberate/:id until the row
    // flips to `completed` (this is what a polling client does in
    // production today).
    expect(res.status).toBe(202);
    const accepted = (await res.json()) as Record<string, unknown>;
    expect(typeof accepted['id']).toBe('string');
    expect(accepted['status']).toBe('in_flight');

    const id = accepted['id'] as string;

    // Poll until terminal — at most ~2s; the mocked engine in this test
    // resolves on the next microtask so a tight loop is sufficient.
    const deadline = Date.now() + 5000;
    let final: Record<string, unknown> | null = null;
    while (Date.now() < deadline) {
      const get = await app.request(`/deliberate/${id}`);
      expect(get.status).toBe(200);
      const body = (await get.json()) as Record<string, unknown>;
      if (body['status'] === 'completed' || body['status'] === 'failed') {
        final = body;
        break;
      }
      // tiny delay so the background promise can settle.
      await new Promise((r) => setImmediate(r));
    }

    expect(final).not.toBeNull();
    expect(final!['status']).toBe('completed');
    expect(final!['topic']).toBe('Should we adopt remote-first culture?');
    expect(Array.isArray(final!['turns'])).toBe(true);
    expect((final!['turns'] as unknown[]).length).toBeGreaterThan(0);
    expect(final!['terminationReason']).toBe('consensus');

    // Row landed in SQLite via real createDeliberationRow + markCompleted.
    const stored = getDeliberation(db, id);
    expect(stored).not.toBeNull();
    expect(stored?.topic).toBe('Should we adopt remote-first culture?');
    expect(stored?.status).toBe('completed');
  });

  it('GET /deliberate/:id returns a previously saved result', async () => {
    const id = 'test-id-123';
    saveDeliberation(db, id, 'Persisted topic', {
      topic: 'Persisted topic',
      turns: [
        {
          agent: 'Proposer',
          neurotype: 'structured',
          model: 'mock',
          content: 'stored content',
          timestamp: '2026-01-01T00:00:00.000Z',
          round: 1,
        },
      ],
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
    });

    const res = await app.request(`/deliberate/${id}`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body['topic']).toBe('Persisted topic');
    expect(body['synthesis']).toBe('final');
  });

  it('GET /deliberate/:id returns 404 for a missing id', async () => {
    const res = await app.request('/deliberate/nope-not-here');
    expect(res.status).toBe(404);
  });

  // -------------------------------------------------------------------------
  // PAR-16: deliberation context — POST + GET round-trip + persistence
  // -------------------------------------------------------------------------
  it('POST /deliberate accepts context, persists it via the placeholder + completion path, and GET round-trips it (PAR-16 + PAR-18)', async () => {
    const context =
      'Endeavour is a single-model reasoning pipeline. ' +
      'Parliament is a multi-agent deliberation engine. ' +
      'The question under deliberation concerns whether to integrate Parliament ' +
      'as a self-deliberation layer inside Endeavour.';

    const res = await app.request('/deliberate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic: 'Should Endeavour integrate Parliament?',
        context,
        config: { maxRounds: 1, confidenceThreshold: 0.7 },
      }),
    });

    // PAR-18 — 202 with mint-on-submit shape; the actual context echo is
    // observed via the persisted row, not the POST body. A pre-PAR-18
    // client that read `context` off the POST response now reads it off
    // the GET /deliberate/:id response (which is the same persisted row).
    expect(res.status).toBe(202);
    const accepted = (await res.json()) as Record<string, unknown>;
    expect(typeof accepted['id']).toBe('string');
    expect(accepted['status']).toBe('in_flight');
    const id = accepted['id'] as string;

    // The placeholder row is inserted synchronously with the context
    // column populated, so the column reads even before the engine
    // finishes.
    const placeholder = getDeliberation(db, id);
    expect(placeholder).not.toBeNull();
    expect(placeholder?.context).toBe(context);

    // Poll until completion.
    const deadline = Date.now() + 5000;
    let final: Record<string, unknown> | null = null;
    while (Date.now() < deadline) {
      const get = await app.request(`/deliberate/${id}`);
      const body = (await get.json()) as Record<string, unknown>;
      if (body['status'] === 'completed' || body['status'] === 'failed') {
        final = body;
        break;
      }
      await new Promise((r) => setImmediate(r));
    }
    expect(final).not.toBeNull();

    // SQLite row carries the context — the dedicated column survives the
    // round-trip even when the JSON blob is stripped.
    const stored = getDeliberation(db, id);
    expect(stored).not.toBeNull();
    expect(stored?.context).toBe(context);
    expect(stored?.status).toBe('completed');

    // GET /deliberate/:id round-trips the context verbatim.
    expect(final!['context']).toBe(context);
    expect(final!['topic']).toBe('Should Endeavour integrate Parliament?');
  });

  it('POST /deliberate without context: persisted row omits the context field (PAR-18)', async () => {
    const res = await app.request('/deliberate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic: 'Plain topic, no context.',
        config: { maxRounds: 1, confidenceThreshold: 0.7 },
      }),
    });

    expect(res.status).toBe(202);
    const accepted = (await res.json()) as Record<string, unknown>;
    const id = accepted['id'] as string;

    // Poll until terminal, then check the GET shape.
    const deadline = Date.now() + 5000;
    let final: Record<string, unknown> | null = null;
    while (Date.now() < deadline) {
      const get = await app.request(`/deliberate/${id}`);
      const body = (await get.json()) as Record<string, unknown>;
      if (body['status'] === 'completed' || body['status'] === 'failed') {
        final = body;
        break;
      }
      await new Promise((r) => setImmediate(r));
    }
    expect(final).not.toBeNull();
    expect(final!['context']).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // PAR-17: structured sources[] — POST + GET round-trip + persistence
  // -------------------------------------------------------------------------
  it('POST /deliberate accepts structured sources, persists them, and GET round-trips them verbatim (PAR-17)', async () => {
    const sources = [
      {
        id: 'foo-2024',
        title: 'foo-2024.md',
        kind: 'paper' as const,
        content:
          'A canonical paper claiming X. Section 1 establishes the baseline; ' +
          'section 2 reports the experiment; section 3 reconciles with prior work.',
      },
      {
        id: 'memo-internal',
        title: 'memo-internal.md',
        kind: 'memo' as const,
        content:
          'Internal memo recording the team disagreement and the final ' +
          'design decision adopted by the architecture council.',
      },
    ];

    const res = await app.request('/deliberate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic: 'Should we adopt approach X?',
        sources,
        config: { maxRounds: 1, confidenceThreshold: 0.7 },
      }),
    });

    expect(res.status).toBe(202);
    const accepted = (await res.json()) as Record<string, unknown>;
    expect(typeof accepted['id']).toBe('string');
    expect(accepted['status']).toBe('in_flight');
    const id = accepted['id'] as string;

    // Placeholder row should already carry the sources array because
    // createDeliberationRow seeds the `result_json` with them.
    const placeholder = getDeliberation(db, id);
    expect(placeholder).not.toBeNull();
    expect(placeholder?.sources).toEqual(sources);

    // Poll until completion.
    const deadline = Date.now() + 5000;
    let final: Record<string, unknown> | null = null;
    while (Date.now() < deadline) {
      const get = await app.request(`/deliberate/${id}`);
      const body = (await get.json()) as Record<string, unknown>;
      if (body['status'] === 'completed' || body['status'] === 'failed') {
        final = body;
        break;
      }
      await new Promise((r) => setImmediate(r));
    }
    expect(final).not.toBeNull();
    expect(final!['status']).toBe('completed');

    // GET round-trips the sources verbatim — both the array structure and
    // every per-source field survive the JSON write/read.
    expect(final!['sources']).toEqual(sources);

    // SQLite row carries them too (round-tripped via result_json).
    const stored = getDeliberation(db, id);
    expect(stored).not.toBeNull();
    expect(stored?.sources).toEqual(sources);
  });

  it('POST /deliberate without sources: persisted row and GET response omit the sources field (PAR-17)', async () => {
    const res = await app.request('/deliberate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic: 'No-sources topic.',
        config: { maxRounds: 1, confidenceThreshold: 0.7 },
      }),
    });

    expect(res.status).toBe(202);
    const accepted = (await res.json()) as Record<string, unknown>;
    const id = accepted['id'] as string;

    const deadline = Date.now() + 5000;
    let final: Record<string, unknown> | null = null;
    while (Date.now() < deadline) {
      const get = await app.request(`/deliberate/${id}`);
      const body = (await get.json()) as Record<string, unknown>;
      if (body['status'] === 'completed' || body['status'] === 'failed') {
        final = body;
        break;
      }
      await new Promise((r) => setImmediate(r));
    }
    expect(final).not.toBeNull();
    expect(final!['sources']).toBeUndefined();

    const stored = getDeliberation(db, id);
    expect(stored?.sources).toBeUndefined();
  });

  it('POST /deliberate rejects sources with empty id/title/content (PAR-17)', async () => {
    const res = await app.request('/deliberate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic: 'Topic with malformed source.',
        sources: [{ id: '', title: 'x', content: 'y' }],
        config: { maxRounds: 1 },
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['error']).toBe('Validation failed');
  });

  it('POST /deliberate rejects sources with an unknown kind (PAR-17)', async () => {
    const res = await app.request('/deliberate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic: 'Topic with bogus kind.',
        sources: [
          { id: 'a', title: 'a', content: 'a', kind: 'not-a-real-kind' },
        ],
        config: { maxRounds: 1 },
      }),
    });

    expect(res.status).toBe(400);
  });
});
