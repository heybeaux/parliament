/**
 * PAR-38 — memory provider + engine wiring.
 *
 * Covers:
 *   1. `EngramMemoryProvider` request/response shape (recall + remember).
 *   2. `formatMemoryFragments` + `formatOutcomeForMemory` — the two prose
 *      formatters the engine relies on.
 *   3. `buildPromptHeader` rendering of the `## Memory` block — its position
 *      (after `## Background`, before `## Sources`) and its absent-when-empty
 *      contract.
 *   4. Engine integration: recall result lands on every agent's user prompt;
 *      `remember()` fires after termination with the right outcome shape;
 *      a throwing provider does NOT block deliberation.
 */

import { describe, it, expect, vi } from 'vitest';
import type { ModelAdapter } from '../adapters/base.js';
import {
  CONTEXT_HEADING,
  MEMORY_HEADING,
  SOURCES_HEADING,
  DeliberationEngine,
  EngramMemoryProvider,
  NoopMemoryProvider,
  ProposerAgent,
  RedAgent,
  SentryAgent,
  SkepticAgent,
  SynthesizerAgent,
  buildPromptHeader,
  formatMemoryFragments,
  formatOutcomeForMemory,
} from '../index.js';
import type {
  MemoryFragment,
  MemoryOutcome,
  MemoryProvider,
  RecallOptions,
  RememberOptions,
} from '../index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface RecordingAdapter extends ModelAdapter {
  generate: ReturnType<typeof vi.fn>;
}

function makeAdapter(role: string, response: string): RecordingAdapter {
  return {
    modelName: `mock-${role}`,
    generate: vi.fn(async () => ({ content: response })),
  };
}

const SYNTH_CONSENSUS_JSON = JSON.stringify({
  summary: 'Both sides agree on the core trade-offs.',
  confidence: 0.9,
  consensus: true,
  agreed: ['shared definition'],
  unresolved: [],
});

function makeFragment(overrides: Partial<MemoryFragment> = {}): MemoryFragment {
  return {
    id: 'mem-1',
    content: 'The team chose Postgres over DynamoDB after benchmarking write latency.',
    layer: 'INSIGHT',
    score: 0.82,
    createdAt: '2026-04-12T08:30:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// formatMemoryFragments / formatOutcomeForMemory
// ---------------------------------------------------------------------------

describe('formatMemoryFragments', () => {
  it('returns empty string for an empty list', () => {
    expect(formatMemoryFragments([])).toBe('');
  });

  it('renders one fragment with the YYYY-MM-DD date prefix', () => {
    const out = formatMemoryFragments([makeFragment()]);
    expect(out).toContain('1 related past decision:');
    expect(out).toContain('- 2026-04-12: The team chose Postgres over DynamoDB');
  });

  it('pluralises the header for multiple fragments and preserves order', () => {
    const out = formatMemoryFragments([
      makeFragment({ id: 'a', content: 'First decision.', createdAt: '2026-01-01T00:00:00.000Z' }),
      makeFragment({ id: 'b', content: 'Second decision.', createdAt: '2026-02-01T00:00:00.000Z' }),
    ]);
    expect(out.startsWith('2 related past decisions:')).toBe(true);
    const aIdx = out.indexOf('First decision');
    const bIdx = out.indexOf('Second decision');
    expect(aIdx).toBeGreaterThan(0);
    expect(bIdx).toBeGreaterThan(aIdx);
  });

  it('collapses internal whitespace in fragment content', () => {
    const out = formatMemoryFragments([
      makeFragment({ content: 'Multi\n\n   line\t  prose.' }),
    ]);
    expect(out).toContain('Multi line prose.');
    expect(out).not.toContain('\n\n   line');
  });
});

describe('formatOutcomeForMemory', () => {
  it('emits Topic / Outcome / Synthesis / Participants in the canonical shape', () => {
    const outcome: MemoryOutcome = {
      topic: 'Should we adopt Engram?',
      terminationReason: 'consensus',
      synthesis: 'Adopt Engram for INSIGHT-layer recall in Phase 1.',
      residueScore: 0.12,
      totalRounds: 3,
      agents: ['Proposer', 'Skeptic', 'Synthesizer'],
    };
    const out = formatOutcomeForMemory(outcome);
    expect(out).toContain('Topic: Should we adopt Engram?');
    expect(out).toContain('Outcome: consensus after 3 rounds (residue 0.12)');
    expect(out).toContain('Synthesis: Adopt Engram for INSIGHT-layer recall in Phase 1.');
    expect(out).toContain('Participants: Proposer, Skeptic, Synthesizer');
  });

  it('uses singular "round" for totalRounds === 1', () => {
    const out = formatOutcomeForMemory({
      topic: 'X',
      terminationReason: 'echo_loop',
      synthesis: null,
      residueScore: 0.5,
      totalRounds: 1,
      agents: ['Proposer'],
    });
    expect(out).toContain('after 1 round (residue 0.50)');
    expect(out).not.toContain('after 1 rounds');
  });

  it('omits the Synthesis line when synthesis is null', () => {
    const out = formatOutcomeForMemory({
      topic: 'X',
      terminationReason: 'max_rounds',
      synthesis: null,
      residueScore: 0,
      totalRounds: 5,
      agents: ['Proposer', 'Skeptic'],
    });
    expect(out).not.toContain('Synthesis:');
  });

  it('omits the Participants line when no agents recorded', () => {
    const out = formatOutcomeForMemory({
      topic: 'X',
      terminationReason: 'echo_loop',
      synthesis: null,
      residueScore: 1,
      totalRounds: 1,
      agents: [],
    });
    expect(out).not.toContain('Participants:');
  });
});

// ---------------------------------------------------------------------------
// buildPromptHeader — the `## Memory` rendering contract
// ---------------------------------------------------------------------------

describe('buildPromptHeader (PAR-38 memory)', () => {
  it('omits the Memory block when no memory is supplied', () => {
    const header = buildPromptHeader('Topic A');
    expect(header).not.toContain(MEMORY_HEADING);
  });

  it('omits the Memory block for a whitespace-only memory string', () => {
    const header = buildPromptHeader('Topic A', undefined, undefined, '   \n\t   ');
    expect(header).not.toContain(MEMORY_HEADING);
  });

  it('renders the Memory block when memory is present', () => {
    const memory = '1 related past decision:\n- 2026-04-12: We chose Postgres.';
    const header = buildPromptHeader('Topic A', undefined, undefined, memory);
    expect(header).toContain(MEMORY_HEADING);
    expect(header).toContain('We chose Postgres.');
  });

  it('places Memory AFTER Background and BEFORE Sources when all three are present', () => {
    const header = buildPromptHeader(
      'Topic A',
      'Project background prose.',
      [{ id: 's1', title: 'Source 1', content: 'Source body.' }],
      '1 related past decision:\n- 2026-04-12: prior decision.',
    );

    const ctxIdx = header.indexOf(CONTEXT_HEADING);
    const memIdx = header.indexOf(MEMORY_HEADING);
    const srcIdx = header.indexOf(SOURCES_HEADING);

    expect(ctxIdx).toBeGreaterThanOrEqual(0);
    expect(memIdx).toBeGreaterThan(ctxIdx);
    expect(srcIdx).toBeGreaterThan(memIdx);
  });

  it('renders Memory under its heading without affecting Background / Sources rendering', () => {
    const header = buildPromptHeader(
      'Topic A',
      'Background body.',
      [{ id: 's1', title: 'Title', content: 'Body.' }],
      'Memory body.',
    );
    expect(header).toContain(`${CONTEXT_HEADING}\n\nBackground body.`);
    expect(header).toContain(`${MEMORY_HEADING}\n\nMemory body.`);
    expect(header).toContain(SOURCES_HEADING);
  });
});

// ---------------------------------------------------------------------------
// EngramMemoryProvider — HTTP shape
// ---------------------------------------------------------------------------

interface FetchCall {
  url: string;
  init: RequestInit;
}

function fakeFetch(response: { ok?: boolean; status?: number; body?: unknown }): {
  fn: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fn: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      statusText: response.status === 500 ? 'Server Error' : 'OK',
      json: async () => response.body ?? {},
    };
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe('EngramMemoryProvider.recall', () => {
  it('POSTs to /v1/memories/query with topic, limit, layers and tenant header', async () => {
    const { fn, calls } = fakeFetch({
      body: {
        results: [
          {
            id: 'mem-1',
            content: 'A past decision.',
            layer: 'INSIGHT',
            score: 0.91,
            createdAt: '2026-04-01T12:00:00.000Z',
          },
        ],
      },
    });
    const provider = new EngramMemoryProvider({
      endpoint: 'https://engram.example.com/',
      apiKey: 'secret-token',
      fetchImpl: fn,
    });

    const fragments = await provider.recall('Should we ship?', { limit: 5, agentId: 'agent-42' });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://engram.example.com/v1/memories/query');
    expect(calls[0]!.init.method).toBe('POST');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    expect(headers['x-am-agent-id']).toBe('agent-42');
    expect(headers.authorization).toBe('Bearer secret-token');
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body).toEqual({
      query: 'Should we ship?',
      limit: 5,
      layers: ['INSIGHT', 'PROJECT'],
    });

    expect(fragments).toEqual([
      {
        id: 'mem-1',
        content: 'A past decision.',
        layer: 'INSIGHT',
        score: 0.91,
        createdAt: '2026-04-01T12:00:00.000Z',
      },
    ]);
  });

  it('honours a custom layers list and omits the auth header when no apiKey set', async () => {
    const { fn, calls } = fakeFetch({ body: { results: [] } });
    const provider = new EngramMemoryProvider({
      endpoint: 'https://engram.example.com',
      layers: ['IDENTITY', 'TASK'],
      fetchImpl: fn,
    });

    await provider.recall('topic', { limit: 3, agentId: 'a' });

    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.layers).toEqual(['IDENTITY', 'TASK']);
  });

  it('falls back to text/created_at when content/createdAt are missing', async () => {
    const { fn } = fakeFetch({
      body: {
        results: [
          {
            id: 'mem-2',
            text: '   spaced prose   ',
            layer: 'unknown-layer',
            score: 0.4,
            created_at: '2026-03-15T00:00:00.000Z',
          },
        ],
      },
    });
    const provider = new EngramMemoryProvider({
      endpoint: 'https://engram.example.com',
      fetchImpl: fn,
    });

    const fragments = await provider.recall('topic', { limit: 1, agentId: 'a' });
    expect(fragments).toHaveLength(1);
    expect(fragments[0]!.content).toBe('spaced prose');
    expect(fragments[0]!.createdAt).toBe('2026-03-15T00:00:00.000Z');
    expect(fragments[0]!.layer).toBe('INSIGHT');
  });

  it('throws on non-2xx so the engine fail-soft wrapper can log it', async () => {
    const { fn } = fakeFetch({ ok: false, status: 500, body: {} });
    const provider = new EngramMemoryProvider({
      endpoint: 'https://engram.example.com',
      fetchImpl: fn,
    });
    await expect(provider.recall('t', { limit: 1, agentId: 'a' })).rejects.toThrow(/500/);
  });

  it('strips a single trailing slash from the endpoint', async () => {
    const { fn, calls } = fakeFetch({ body: { results: [] } });
    const provider = new EngramMemoryProvider({
      endpoint: 'https://engram.example.com/',
      fetchImpl: fn,
    });
    await provider.recall('t', { limit: 1, agentId: 'a' });
    expect(calls[0]!.url).toBe('https://engram.example.com/v1/memories/query');
  });
});

describe('EngramMemoryProvider.remember', () => {
  it('POSTs to /v1/memories with the formatted summary + structured metadata', async () => {
    const { fn, calls } = fakeFetch({ body: {} });
    const provider = new EngramMemoryProvider({
      endpoint: 'https://engram.example.com',
      apiKey: 't',
      fetchImpl: fn,
    });

    await provider.remember(
      {
        topic: 'X?',
        terminationReason: 'consensus',
        synthesis: 'Yes.',
        residueScore: 0.1,
        totalRounds: 2,
        agents: ['Proposer', 'Skeptic'],
      },
      { agentId: 'agent-7' },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://engram.example.com/v1/memories');
    expect(calls[0]!.init.method).toBe('POST');
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.layer).toBe('INSIGHT');
    expect(body.content).toContain('Topic: X?');
    expect(body.content).toContain('Outcome: consensus after 2 rounds (residue 0.10)');
    expect(body.content).toContain('Synthesis: Yes.');
    expect(body.metadata).toEqual({
      source: 'parliament',
      topic: 'X?',
      terminationReason: 'consensus',
      residueScore: 0.1,
      totalRounds: 2,
      agents: ['Proposer', 'Skeptic'],
    });
  });

  it('throws on non-2xx', async () => {
    const { fn } = fakeFetch({ ok: false, status: 502, body: {} });
    const provider = new EngramMemoryProvider({
      endpoint: 'https://engram.example.com',
      fetchImpl: fn,
    });
    await expect(
      provider.remember(
        {
          topic: 't',
          terminationReason: 'consensus',
          synthesis: null,
          residueScore: 0,
          totalRounds: 1,
          agents: [],
        },
        { agentId: 'a' },
      ),
    ).rejects.toThrow(/502/);
  });
});

describe('NoopMemoryProvider', () => {
  it('returns an empty fragment list and resolves remember() without throwing', async () => {
    const provider = new NoopMemoryProvider();
    expect(await provider.recall('t', { limit: 1, agentId: 'a' })).toEqual([]);
    await expect(
      provider.remember(
        {
          topic: 't',
          terminationReason: 'consensus',
          synthesis: null,
          residueScore: 0,
          totalRounds: 1,
          agents: [],
        },
        { agentId: 'a' },
      ),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Engine integration
// ---------------------------------------------------------------------------

class StubProvider implements MemoryProvider {
  recall = vi.fn(
    async (_topic: string, _opts: RecallOptions): Promise<MemoryFragment[]> => [
      makeFragment({ content: 'We previously chose Postgres for the write path.' }),
    ],
  );
  remember = vi.fn(
    async (_outcome: MemoryOutcome, _opts: RememberOptions): Promise<void> => {
      return;
    },
  );
}

class ThrowingRecallProvider implements MemoryProvider {
  recall = vi.fn(async () => {
    throw new Error('engram unreachable');
  });
  remember = vi.fn(async () => {
    return;
  });
}

class ThrowingRememberProvider implements MemoryProvider {
  recall = vi.fn(async () => [] as MemoryFragment[]);
  remember = vi.fn(async () => {
    throw new Error('engram write failed');
  });
}

function makeAgents() {
  return {
    proposerAdapter: makeAdapter('proposer', 'Proposer prose.'),
    skepticAdapter: makeAdapter('skeptic', 'Skeptic prose.'),
    synthesizerAdapter: makeAdapter('synthesizer', SYNTH_CONSENSUS_JSON),
    redAdapter: makeAdapter('redAgent', 'RedAgent prose.'),
    sentryAdapter: makeAdapter('sentry', 'unused'),
  };
}

describe('DeliberationEngine.run (PAR-38 memory integration)', () => {
  it('calls recall() before round 1 and surfaces fragments under ## Memory in every prompt', async () => {
    const adapters = makeAgents();
    const provider = new StubProvider();

    const engine = new DeliberationEngine();
    const result = await engine.run('Should we adopt Engram?', {
      maxRounds: 1,
      redAgentInterval: 99,
      confidenceThreshold: 0.7,
      memoryProvider: provider,
      memoryAgentId: 'tenant-9',
      agents: {
        proposer: new ProposerAgent(adapters.proposerAdapter),
        skeptic: new SkepticAgent(adapters.skepticAdapter),
        synthesizer: new SynthesizerAgent(adapters.synthesizerAdapter),
        redAgent: new RedAgent(adapters.redAdapter),
        sentry: new SentryAgent(adapters.sentryAdapter),
      },
    });

    expect(provider.recall).toHaveBeenCalledTimes(1);
    expect(provider.recall.mock.calls[0]![0]).toBe('Should we adopt Engram?');
    expect(provider.recall.mock.calls[0]![1]).toEqual({ limit: 5, agentId: 'tenant-9' });

    const expectedMemory =
      '1 related past decision:\n- 2026-04-12: We previously chose Postgres for the write path.';
    expect(result.memory).toBe(expectedMemory);

    for (const adapter of [
      adapters.proposerAdapter,
      adapters.skepticAdapter,
      adapters.synthesizerAdapter,
    ]) {
      expect(adapter.generate).toHaveBeenCalled();
      for (const call of adapter.generate.mock.calls) {
        const userPrompt = call[0] as string;
        expect(userPrompt).toContain(MEMORY_HEADING);
        expect(userPrompt).toContain('We previously chose Postgres');
      }
    }
  });

  it('honours a custom memoryRecallLimit', async () => {
    const adapters = makeAgents();
    const provider = new StubProvider();

    const engine = new DeliberationEngine();
    await engine.run('topic', {
      maxRounds: 1,
      redAgentInterval: 99,
      confidenceThreshold: 0.7,
      memoryProvider: provider,
      memoryAgentId: 'a',
      memoryRecallLimit: 12,
      agents: {
        proposer: new ProposerAgent(adapters.proposerAdapter),
        skeptic: new SkepticAgent(adapters.skepticAdapter),
        synthesizer: new SynthesizerAgent(adapters.synthesizerAdapter),
        redAgent: new RedAgent(adapters.redAdapter),
        sentry: new SentryAgent(adapters.sentryAdapter),
      },
    });

    expect(provider.recall.mock.calls[0]![1].limit).toBe(12);
  });

  it('fires remember() after termination with the resolved outcome shape', async () => {
    const adapters = makeAgents();
    const provider = new StubProvider();

    const engine = new DeliberationEngine();
    await engine.run('Should we adopt Engram?', {
      maxRounds: 1,
      redAgentInterval: 99,
      confidenceThreshold: 0.7,
      memoryProvider: provider,
      memoryAgentId: 'tenant-9',
      agents: {
        proposer: new ProposerAgent(adapters.proposerAdapter),
        skeptic: new SkepticAgent(adapters.skepticAdapter),
        synthesizer: new SynthesizerAgent(adapters.synthesizerAdapter),
        redAgent: new RedAgent(adapters.redAdapter),
        sentry: new SentryAgent(adapters.sentryAdapter),
      },
    });

    // remember() is fire-and-forget; allow the microtask queue to flush.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(provider.remember).toHaveBeenCalledTimes(1);
    const [outcome, opts] = provider.remember.mock.calls[0]!;
    expect(outcome.topic).toBe('Should we adopt Engram?');
    expect(outcome.terminationReason).toBe('consensus');
    expect(outcome.totalRounds).toBe(1);
    expect(opts).toEqual({ agentId: 'tenant-9' });
    // Participants are pulled from the actual blackboard turns.
    expect(outcome.agents).toEqual(
      expect.arrayContaining(['Proposer', 'Skeptic', 'Synthesizer']),
    );
  });

  it('does NOT inject the Memory heading when no provider is configured', async () => {
    const adapters = makeAgents();
    const engine = new DeliberationEngine();
    const result = await engine.run('plain', {
      maxRounds: 1,
      redAgentInterval: 99,
      confidenceThreshold: 0.7,
      agents: {
        proposer: new ProposerAgent(adapters.proposerAdapter),
        skeptic: new SkepticAgent(adapters.skepticAdapter),
        synthesizer: new SynthesizerAgent(adapters.synthesizerAdapter),
        redAgent: new RedAgent(adapters.redAdapter),
        sentry: new SentryAgent(adapters.sentryAdapter),
      },
    });

    expect(result.memory).toBeUndefined();
    for (const adapter of [
      adapters.proposerAdapter,
      adapters.skepticAdapter,
      adapters.synthesizerAdapter,
    ]) {
      for (const call of adapter.generate.mock.calls) {
        expect(call[0] as string).not.toContain(MEMORY_HEADING);
      }
    }
  });

  it('skips memory wiring when memoryAgentId is missing', async () => {
    const adapters = makeAgents();
    const provider = new StubProvider();
    const engine = new DeliberationEngine();
    const result = await engine.run('plain', {
      maxRounds: 1,
      redAgentInterval: 99,
      confidenceThreshold: 0.7,
      memoryProvider: provider,
      // no memoryAgentId
      agents: {
        proposer: new ProposerAgent(adapters.proposerAdapter),
        skeptic: new SkepticAgent(adapters.skepticAdapter),
        synthesizer: new SynthesizerAgent(adapters.synthesizerAdapter),
        redAgent: new RedAgent(adapters.redAdapter),
        sentry: new SentryAgent(adapters.sentryAdapter),
      },
    });

    expect(provider.recall).not.toHaveBeenCalled();
    expect(provider.remember).not.toHaveBeenCalled();
    expect(result.memory).toBeUndefined();
  });

  it('omits the Memory heading when recall() returns no fragments', async () => {
    const adapters = makeAgents();
    const provider: MemoryProvider = {
      recall: vi.fn(async () => []),
      remember: vi.fn(async () => {
        return;
      }),
    };

    const engine = new DeliberationEngine();
    const result = await engine.run('plain', {
      maxRounds: 1,
      redAgentInterval: 99,
      confidenceThreshold: 0.7,
      memoryProvider: provider,
      memoryAgentId: 'a',
      agents: {
        proposer: new ProposerAgent(adapters.proposerAdapter),
        skeptic: new SkepticAgent(adapters.skepticAdapter),
        synthesizer: new SynthesizerAgent(adapters.synthesizerAdapter),
        redAgent: new RedAgent(adapters.redAdapter),
        sentry: new SentryAgent(adapters.sentryAdapter),
      },
    });

    expect(provider.recall).toHaveBeenCalledTimes(1);
    expect(result.memory).toBeUndefined();
    for (const call of adapters.proposerAdapter.generate.mock.calls) {
      expect(call[0] as string).not.toContain(MEMORY_HEADING);
    }
  });
});

describe('DeliberationEngine.run (PAR-38 fail-soft)', () => {
  it('proceeds normally when recall() throws', async () => {
    const adapters = makeAgents();
    const provider = new ThrowingRecallProvider();
    // Silence the expected console.warn for the duration of the test.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const engine = new DeliberationEngine();
    const result = await engine.run('topic', {
      maxRounds: 1,
      redAgentInterval: 99,
      confidenceThreshold: 0.7,
      memoryProvider: provider,
      memoryAgentId: 'a',
      agents: {
        proposer: new ProposerAgent(adapters.proposerAdapter),
        skeptic: new SkepticAgent(adapters.skepticAdapter),
        synthesizer: new SynthesizerAgent(adapters.synthesizerAdapter),
        redAgent: new RedAgent(adapters.redAdapter),
        sentry: new SentryAgent(adapters.sentryAdapter),
      },
    });

    expect(result.terminationReason).toBe('consensus');
    expect(result.memory).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('memory.recall failed'),
    );
    warnSpy.mockRestore();
  });

  it('proceeds normally when remember() rejects (fire-and-forget)', async () => {
    const adapters = makeAgents();
    const provider = new ThrowingRememberProvider();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const engine = new DeliberationEngine();
    const result = await engine.run('topic', {
      maxRounds: 1,
      redAgentInterval: 99,
      confidenceThreshold: 0.7,
      memoryProvider: provider,
      memoryAgentId: 'a',
      agents: {
        proposer: new ProposerAgent(adapters.proposerAdapter),
        skeptic: new SkepticAgent(adapters.skepticAdapter),
        synthesizer: new SynthesizerAgent(adapters.synthesizerAdapter),
        redAgent: new RedAgent(adapters.redAdapter),
        sentry: new SentryAgent(adapters.sentryAdapter),
      },
    });

    expect(result.terminationReason).toBe('consensus');

    // Wait for the detached remember() chain to settle.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('memory.remember failed'),
    );
    warnSpy.mockRestore();
  });
});
