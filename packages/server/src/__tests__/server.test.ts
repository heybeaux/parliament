import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DeliberationResult } from '@parliament/core';

// ---------------------------------------------------------------------------
// Mock @parliament/core so no real Ollama connection is needed
// ---------------------------------------------------------------------------
vi.mock('@parliament/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@parliament/core')>();

  const mockResult: DeliberationResult = {
    topic: 'test topic',
    turns: [
      {
        agent: 'Proposer',
        neurotype: 'divergent',
        model: 'mock-model',
        content: 'initial proposal',
        timestamp: '2026-01-01T00:00:00.000Z',
        round: 1,
      },
    ],
    conflicts: [],
    residueScore: 0,
    resolved: true,
    synthesis: 'Synthesized conclusion.',
    split: null,
    terminationReason: 'consensus',
    totalRounds: 1,
    started_at: '2026-01-01T00:00:00.000Z',
    completed_at: '2026-01-01T00:00:30.000Z',
    events: [],
  };

  const MockDeliberationEngine = vi.fn().mockImplementation(() => ({
    run: vi.fn().mockResolvedValue(mockResult),
    runTopology: vi.fn().mockResolvedValue(mockResult),
  }));

  // Default topology config: built-in Debate preset is active. Tests that need
  // a different active preset can override via vi.mocked(loadTopologyConfig).
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
        // Stage 1 built-in neurotypes — required for non-Debate preset paths.
        historian: { model: 'mock', system_prompt: 'You are a historian.' },
        forecaster: { model: 'mock', system_prompt: 'You are a forecaster.' },
        pragmatist: { model: 'mock', system_prompt: 'You are a pragmatist.' },
        empiricist: { model: 'mock', system_prompt: 'You are an empiricist.' },
        steelmanner: { model: 'mock', system_prompt: 'You are a steelmanner.' },
        'devils-advocate': { model: 'mock', system_prompt: "You are a devil's advocate." },
        lateralist: { model: 'mock', system_prompt: 'You are a lateralist.' },
        translator: { model: 'mock', system_prompt: 'You are a translator.' },
      },
    }),
    buildAgentsFromConfig: vi.fn().mockReturnValue([
      { name: 'proposer', neurotype: 'proposer', model: 'mock', adapter: { generate: vi.fn().mockResolvedValue('ok') }, systemPrompt: '' },
      { name: 'skeptic', neurotype: 'skeptic', model: 'mock', adapter: { generate: vi.fn().mockResolvedValue('ok') }, systemPrompt: '' },
      { name: 'synthesizer', neurotype: 'synthesizer', model: 'mock', adapter: { generate: vi.fn().mockResolvedValue('ok') }, systemPrompt: '' },
      { name: 'redAgent', neurotype: 'redAgent', model: 'mock', adapter: { generate: vi.fn().mockResolvedValue('ok') }, systemPrompt: '' },
      { name: 'sentry', neurotype: 'sentry', model: 'mock', adapter: { generate: vi.fn().mockResolvedValue('ok') }, systemPrompt: '' },
    ]),
    createAdapter: vi.fn().mockReturnValue({
      generate: vi.fn().mockResolvedValue('ok'),
    }),
    ProposerAgent: vi.fn().mockImplementation(() => ({
      role: 'Proposer',
      neurotype: 'divergent',
      generate: vi.fn(),
    })),
    SkepticAgent: vi.fn().mockImplementation(() => ({
      role: 'Skeptic',
      neurotype: 'analytical',
      generate: vi.fn(),
    })),
    SynthesizerAgent: vi.fn().mockImplementation(() => ({
      role: 'Synthesizer',
      neurotype: 'integrative',
      generate: vi.fn(),
    })),
    RedAgent: vi.fn().mockImplementation(() => ({
      role: 'RedAgent',
      neurotype: 'adversarial',
      generate: vi.fn(),
    })),
    SentryAgent: vi.fn().mockImplementation(() => ({
      role: 'Sentry',
      neurotype: 'monitoring',
      generate: vi.fn(),
    })),
    ModelConnectionError: actual.ModelConnectionError,
  };
});

// ---------------------------------------------------------------------------
// Mock the db module so no real SQLite file is needed
// ---------------------------------------------------------------------------
const mockSaveDeliberation = vi.fn();
const mockGetDeliberation = vi.fn();

vi.mock('../db.js', () => ({
  initDb: vi.fn().mockReturnValue({}),
  saveDeliberation: (...args: unknown[]) => mockSaveDeliberation(...args),
  getDeliberation: (...args: unknown[]) => mockGetDeliberation(...args),
}));

// ---------------------------------------------------------------------------
// Import the router after mocks are set up
// ---------------------------------------------------------------------------
import { createRouter } from '../routes.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeApp() {
  const fakeDb = {} as import('better-sqlite3').Database;
  return createRouter(fakeDb);
}

const MOCK_RESULT: DeliberationResult = {
  topic: 'test topic',
  turns: [
    {
      agent: 'Proposer',
      neurotype: 'divergent',
      model: 'mock-model',
      content: 'initial proposal',
      timestamp: '2026-01-01T00:00:00.000Z',
      round: 1,
    },
  ],
  conflicts: [],
  residueScore: 0,
  resolved: true,
  synthesis: 'Synthesized conclusion.',
  split: null,
  terminationReason: 'consensus',
  totalRounds: 1,
  started_at: '2026-01-01T00:00:00.000Z',
  completed_at: '2026-01-01T00:00:30.000Z',
  events: [],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /deliberate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSaveDeliberation.mockReturnValue(undefined);
  });

  it('returns 200 with result shape on valid request', async () => {
    const app = makeApp();

    const res = await app.request('/deliberate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: 'test topic' }),
    });

    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;
    expect(typeof body['id']).toBe('string');
    expect(body['topic']).toBe('test topic');
    expect(body['resolved']).toBe(true);
    expect(body['terminationReason']).toBe('consensus');
    expect(Array.isArray(body['turns'])).toBe(true);
    expect(Array.isArray(body['conflicts'])).toBe(true);
    expect(typeof body['residueScore']).toBe('number');
  });

  it('returns 200 and persists result with an id', async () => {
    const app = makeApp();

    const res = await app.request('/deliberate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: 'persistence test' }),
    });

    expect(res.status).toBe(200);
    expect(mockSaveDeliberation).toHaveBeenCalledOnce();

    const [, savedId, savedTopic] = mockSaveDeliberation.mock.calls[0] as [unknown, string, string];
    expect(typeof savedId).toBe('string');
    expect(savedId.length).toBeGreaterThan(0);
    expect(savedTopic).toBe('persistence test');
  });

  it('returns 400 with Zod error when topic is missing', async () => {
    const app = makeApp();

    const res = await app.request('/deliberate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: { maxRounds: 3 } }),
    });

    expect(res.status).toBe(400);

    const body = await res.json() as Record<string, unknown>;
    expect(body['error']).toBe('Validation failed');
    expect(Array.isArray(body['issues'])).toBe(true);
  });

  it('returns 400 when topic is an empty string', async () => {
    const app = makeApp();

    const res = await app.request('/deliberate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: '' }),
    });

    expect(res.status).toBe(400);

    const body = await res.json() as Record<string, unknown>;
    expect(body['error']).toBe('Validation failed');
  });

  it('accepts optional config overrides', async () => {
    const app = makeApp();

    const res = await app.request('/deliberate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic: 'override test',
        config: { maxRounds: 10, confidenceThreshold: 0.9 },
      }),
    });

    expect(res.status).toBe(200);
  });

  it('forwards optional context to runTopology and echoes it on the response (PAR-16)', async () => {
    const { DeliberationEngine } = await import('@parliament/core');
    const EngineMock = vi.mocked(DeliberationEngine);

    const context = 'A multi-paragraph background brief about the system at hand.';

    // Drive the engine mock so its returned result carries the context the
    // server forwarded, mirroring real engine behaviour.
    EngineMock.mockImplementationOnce(() => ({
      run: vi.fn(),
      runTopology: vi.fn(async (_topic: string, cfg: { context?: string }) => ({
        topic: 'context test',
        ...(cfg.context !== undefined ? { context: cfg.context } : {}),
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
      })),
    }) as unknown as InstanceType<typeof DeliberationEngine>);

    const app = makeApp();

    const res = await app.request('/deliberate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: 'context test', context }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['context']).toBe(context);

    // The engine instance received the context on its runTopology config.
    const lastInstance = EngineMock.mock.results.at(-1)!.value as {
      runTopology: ReturnType<typeof vi.fn>;
    };
    type RunTopologyArgs = [string, { context?: string }];
    const [, configArg] = lastInstance.runTopology.mock.calls[0] as RunTopologyArgs;
    expect(configArg.context).toBe(context);
  });

  it('omits context from runTopology config when not supplied (PAR-16)', async () => {
    const { DeliberationEngine } = await import('@parliament/core');
    const EngineMock = vi.mocked(DeliberationEngine);
    const app = makeApp();

    const res = await app.request('/deliberate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: 'no context here' }),
    });

    expect(res.status).toBe(200);
    const lastInstance = EngineMock.mock.results.at(-1)!.value as {
      runTopology: ReturnType<typeof vi.fn>;
    };
    type RunTopologyArgs = [string, { context?: string }];
    const [, configArg] = lastInstance.runTopology.mock.calls[0] as RunTopologyArgs;
    expect(configArg.context).toBeUndefined();
  });

  it('returns 400 when body is not valid JSON', async () => {
    const app = makeApp();

    const res = await app.request('/deliberate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });

    expect(res.status).toBe(400);
  });
});

describe('GET /deliberate/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 200 with the deliberation result when found', async () => {
    mockGetDeliberation.mockReturnValue(MOCK_RESULT);

    const app = makeApp();

    const res = await app.request('/deliberate/some-uuid-123');

    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;
    expect(body['topic']).toBe('test topic');
    expect(body['resolved']).toBe(true);
    expect(mockGetDeliberation).toHaveBeenCalledWith({}, 'some-uuid-123');
  });

  it('returns 404 when deliberation is not found', async () => {
    mockGetDeliberation.mockReturnValue(null);

    const app = makeApp();

    const res = await app.request('/deliberate/nonexistent-id');

    expect(res.status).toBe(404);

    const body = await res.json() as Record<string, unknown>;
    expect(typeof body['error']).toBe('string');
    expect((body['error'] as string).toLowerCase()).toContain('not found');
  });
});

describe('GET /presets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the full preset registry plus defaultPreset', async () => {
    const app = makeApp();

    const res = await app.request('/presets');
    expect(res.status).toBe(200);

    const body = (await res.json()) as { presets: unknown[]; defaultPreset: string };
    expect(Array.isArray(body.presets)).toBe(true);
    expect(body.presets.length).toBeGreaterThan(0);

    // Each preset entry exposes the full required-metadata triple plus steps.
    const presets = body.presets as Array<{
      id: string;
      name: string;
      description: string;
      best_for: string;
      isBuiltin: boolean;
      steps: Array<{ id: string; neurotype: string; optional: boolean }>;
    }>;
    for (const p of presets) {
      expect(typeof p.id).toBe('string');
      expect(typeof p.name).toBe('string');
      expect(typeof p.description).toBe('string');
      expect(typeof p.best_for).toBe('string');
      expect(typeof p.isBuiltin).toBe('boolean');
      expect(Array.isArray(p.steps)).toBe(true);
    }

    // All six Stage 1 built-ins must surface.
    const ids = presets.map((p) => p.id).sort();
    expect(ids).toContain('debate');
    expect(ids).toContain('star-chamber');
    expect(ids).toContain('chain-of-verifiers');
    expect(ids).toContain('socratic');
    expect(ids).toContain('long-view');
    expect(ids).toContain('reframe');

    // Default reflects the resolved active preset (debate, per the loader's
    // fallback when [topology] is absent).
    expect(body.defaultPreset).toBe('debate');
  });
});

describe('POST /deliberate — preset override (AC: precedence)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSaveDeliberation.mockReturnValue(undefined);
  });

  it('routes through runTopology when a request preset is supplied', async () => {
    const { DeliberationEngine } = await import('@parliament/core');
    const EngineMock = vi.mocked(DeliberationEngine);
    const app = makeApp();

    const res = await app.request('/deliberate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: 'preset override', preset: 'star-chamber' }),
    });

    expect(res.status).toBe(200);
    // The mock's most recent engine instance must have had runTopology
    // invoked, NOT run, because the request specified a non-default preset.
    const lastInstance = EngineMock.mock.results.at(-1)!.value as {
      run: ReturnType<typeof vi.fn>;
      runTopology: ReturnType<typeof vi.fn>;
    };
    expect(lastInstance.runTopology).toHaveBeenCalledTimes(1);
    expect(lastInstance.run).not.toHaveBeenCalled();
  });

  it('routes the default-preset (debate) path through runTopology, not legacy run()', async () => {
    // PAR-7: every deliberation goes through the topology runtime, including
    // the default Debate preset. The legacy hardcoded five-agent run() path
    // is gone — runTopology(active=debate) is byte-identical per the engine's
    // own byte-identical-debate.test.ts regression test.
    const { DeliberationEngine } = await import('@parliament/core');
    const EngineMock = vi.mocked(DeliberationEngine);
    const app = makeApp();

    const res = await app.request('/deliberate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: 'default debate path' }),
    });

    expect(res.status).toBe(200);
    const lastInstance = EngineMock.mock.results.at(-1)!.value as {
      run: ReturnType<typeof vi.fn>;
      runTopology: ReturnType<typeof vi.fn>;
    };
    expect(lastInstance.runTopology).toHaveBeenCalledTimes(1);
    expect(lastInstance.run).not.toHaveBeenCalled();
  });

  it('passes the resolved Socratic topology config into runTopology when preset="socratic"', async () => {
    // PAR-7 happy-path: a request with a non-default sequential preset must
    // forward the resolved topology (active preset + per-step neurotype
    // resolver + Sentry/Synth/RedAgent infra) into runTopology so the engine
    // can walk the preset's `steps` array. We assert against the call args
    // because the underlying engine is mocked — there are no real "turns"
    // to inspect, but the topology config is the load-bearing wire shape.
    const { DeliberationEngine, BUILTIN_PRESETS } = await import('@parliament/core');
    const EngineMock = vi.mocked(DeliberationEngine);
    const app = makeApp();

    const res = await app.request('/deliberate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: 'socratic happy path', preset: 'socratic' }),
    });

    expect(res.status).toBe(200);
    const lastInstance = EngineMock.mock.results.at(-1)!.value as {
      run: ReturnType<typeof vi.fn>;
      runTopology: ReturnType<typeof vi.fn>;
    };
    expect(lastInstance.runTopology).toHaveBeenCalledTimes(1);

    type RunTopologyArgs = [
      string,
      {
        topology: {
          activePreset: { id: string; steps: Array<{ id: string; neurotype: string }> };
        };
        synthesizer: unknown;
        redAgent: unknown;
        sentry: unknown;
        resolveNeurotype: (step: { id: string; neurotype: string }) => unknown;
      },
    ];
    const [topicArg, configArg] = lastInstance.runTopology.mock.calls[0] as RunTopologyArgs;
    expect(topicArg).toBe('socratic happy path');

    // The active preset must be Socratic and its steps must match the registry.
    expect(configArg.topology.activePreset.id).toBe('socratic');
    const stepNeurotypes = configArg.topology.activePreset.steps.map((s) => s.neurotype);
    expect(stepNeurotypes).toEqual(
      BUILTIN_PRESETS['socratic']!.steps.map((s) => s.neurotype),
    );
    // Sentry must NOT appear in the preset's steps (out-of-band invariant).
    expect(stepNeurotypes).not.toContain('sentry');

    // Structural-infrastructure trio must be wired in.
    expect(configArg.synthesizer).toBeDefined();
    expect(configArg.redAgent).toBeDefined();
    expect(configArg.sentry).toBeDefined();

    // The neurotype resolver must be a callable that the engine can invoke
    // per step. We do a smoke check — calling it with the first Socratic
    // step must not throw.
    expect(typeof configArg.resolveNeurotype).toBe('function');
    const firstStep = configArg.topology.activePreset.steps[0]!;
    expect(() => configArg.resolveNeurotype(firstStep)).not.toThrow();
  });

  it('returns 400 with descriptive error when the preset is unknown', async () => {
    const app = makeApp();

    const res = await app.request('/deliberate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: 'bad preset', preset: 'xyzzy' }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body['error']).toBe('string');
    expect(body['error']).toMatch(/unknown preset "xyzzy"/);
    // Available presets list must accompany the error so clients can recover.
    expect(body['error']).toMatch(/Available presets/);
    expect(body['code']).toBe('unknown_active_preset');
  });
});

describe('GET /health', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 200 with status ok and model statuses', async () => {
    const app = makeApp();

    const res = await app.request('/health');

    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;
    expect(body['status']).toBe('ok');

    const models = body['models'] as Record<string, string>;
    expect(typeof models).toBe('object');

    // All five roles should be present
    for (const role of ['proposer', 'skeptic', 'synthesizer', 'redAgent', 'sentry']) {
      expect(['connected', 'unreachable']).toContain(models[role]);
    }
  });

  it('marks a model as unreachable when its adapter throws', async () => {
    // Override createAdapter to throw for one call
    const { createAdapter } = await import('@parliament/core');
    vi.mocked(createAdapter).mockReturnValueOnce({
      modelName: 'test-model',
      generate: vi.fn().mockRejectedValue(new Error('connection refused')),
    });

    const app = makeApp();
    const res = await app.request('/health');

    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;
    expect(body['status']).toBe('ok');

    const models = body['models'] as Record<string, string>;
    // At least one role should be unreachable
    const statuses = Object.values(models);
    expect(statuses.some((s) => s === 'unreachable')).toBe(true);
  });
});
