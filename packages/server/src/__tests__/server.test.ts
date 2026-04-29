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
  };

  const MockDeliberationEngine = vi.fn().mockImplementation(() => ({
    run: vi.fn().mockResolvedValue(mockResult),
  }));

  return {
    ...actual,
    DeliberationEngine: MockDeliberationEngine,
    loadConfig: vi.fn().mockReturnValue({
      neurotypes: {
        proposer: { model: 'mock', system_prompt: 'You are a proposer.' },
        skeptic: { model: 'mock', system_prompt: 'You are a skeptic.' },
        synthesizer: { model: 'mock', system_prompt: 'You are a synthesizer.' },
        redAgent: { model: 'mock', system_prompt: 'You are a red agent.' },
        sentry: { model: 'mock', system_prompt: 'You are a sentry.' },
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
