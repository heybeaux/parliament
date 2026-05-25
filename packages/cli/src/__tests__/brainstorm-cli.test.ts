/**
 * CLI `brainstorm` command tests.
 *
 * Pins the wire shape of the CLI -> server contract for /brainstorm and
 * /brainstorm/forge:
 *   - --print-lineup short-circuits before any HTTP call.
 *   - Happy path POSTs to /brainstorm, polls GET /brainstorm/:id until terminal,
 *     and prints ranked ideas.
 *   - --forge POSTs to /brainstorm/forge and renders elaborations.
 *   - --k and --ideas-per-author forwarded in POST body.
 *   - Server `error` status surfaces on stderr with a non-zero exit.
 *
 * Strategy:
 *   - Mock @parliament/core to provide resolveBrainstormLineup without real IO.
 *   - Mock global.fetch to script the POST + GET responses inline.
 *   - Mirror the ideate-cli.test.ts helper patterns for consistency.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { BrainstormLineup, BrainstormRanking, BrainstormRankedIdea } from '@parliament/core';

// ---------------------------------------------------------------------------
// Mocks — hoisted
// ---------------------------------------------------------------------------

const MOCK_LINEUP: BrainstormLineup = {
  divergentAuthors: [
    { role: 'divergent-author', model: 'anthropic/claude-opus-4-6' },
    { role: 'divergent-author', model: 'openai/gpt-5' },
  ],
  judges: [
    { role: 'judge', model: 'anthropic/claude-sonnet-4-6' },
    { role: 'judge', model: 'openai/gpt-5' },
  ],
  cluster: { role: 'cluster', model: 'anthropic/claude-opus-4-6' },
  forgeElaborator: { role: 'forge-elaborator', model: 'anthropic/claude-opus-4-6' },
};

vi.mock('@parliament/core', () => ({
  resolveBrainstormLineup: vi.fn().mockReturnValue(MOCK_LINEUP),
  // Stubs for the deliberate/ideate commands imported in the same module.
  loadConfig: vi.fn().mockReturnValue({ neurotypes: {}, ideate: {} }),
  resolveLineup: vi.fn().mockReturnValue({
    mode: 'cooperative',
    synth: 'mock-model',
    team: { cooperative: [], adversarial: [] },
  }),
  loadTopologyConfig: vi.fn(),
  resolveActivePreset: vi.fn(),
  TopologyValidationError: class extends Error {},
  isBuiltinNeurotype: vi.fn().mockReturnValue(false),
  createBuiltinAgent: vi.fn(),
  StubNeurotypeAgent: vi.fn(),
  buildMemoryProvider: vi.fn(),
  createAdapter: vi.fn(),
  DeliberationEngine: vi.fn(),
  ProposerAgent: vi.fn(),
  SkepticAgent: vi.fn(),
  SynthesizerAgent: vi.fn(),
  RedAgent: vi.fn(),
  SentryAgent: vi.fn(),
  DEFAULT_PARLIAMENT_DEFAULTS: {
    max_rounds: 3,
    confidence_threshold: 0.7,
    red_agent_interval: 3,
    osi_enabled: true,
    server_port: 3000,
  },
}));

vi.mock('../display.js', () => ({
  printResult: vi.fn(),
  printTurn: vi.fn(),
  formatTurnHeader: vi.fn().mockReturnValue('[MOCK]'),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FetchScriptEntry {
  status: number;
  body: unknown;
}
interface FetchScript {
  post?: FetchScriptEntry;
  gets: FetchScriptEntry[];
}

function makeResponse(entry: FetchScriptEntry): Response {
  return new Response(JSON.stringify(entry.body), {
    status: entry.status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function installFetchMock(script: FetchScript): {
  posts: Array<{ url: string; body: unknown }>;
  gets: string[];
} {
  const posts: Array<{ url: string; body: unknown }> = [];
  const gets: string[] = [];
  let getIdx = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const parsed = init.body !== undefined ? JSON.parse(init.body as string) : null;
        posts.push({ url, body: parsed });
        if (script.post === undefined) {
          throw new Error('fetch mock: no POST scripted');
        }
        return makeResponse(script.post);
      }
      gets.push(url as string);
      const entry = script.gets[getIdx];
      if (entry === undefined) {
        throw new Error(`fetch mock: GET ${url} ran out of scripted responses`);
      }
      getIdx += 1;
      return makeResponse(entry);
    }),
  );
  return { posts, gets };
}

function captureStream(stream: NodeJS.WriteStream): { read: () => string; restore: () => void } {
  let captured = '';
  const original = stream.write.bind(stream);
  stream.write = ((chunk: unknown) => {
    captured += String(chunk);
    return true;
  }) as typeof stream.write;
  return {
    read: () => captured,
    restore: () => {
      stream.write = original;
    },
  };
}

function makeRankedIdea(over: Partial<BrainstormRankedIdea> = {}): BrainstormRankedIdea {
  return {
    idea_id: 'idea-001',
    title: 'Test Idea',
    one_liner: 'A great idea for testing',
    dimensions: ['tech', 'product'],
    rationale: 'It makes sense',
    cluster: 'Tech cluster',
    final_score: 7.5,
    criteria_scores: { novelty: 8.0, feasibility: 7.0, fit: 8.0, evidence: 7.0 },
    judges_attempted: ['anthropic/claude-sonnet-4-6'],
    judges_skipped: [],
    rank: 1,
    judge_skipped: false,
    ...over,
  };
}

function makeRanking(over: Partial<BrainstormRanking> = {}): BrainstormRanking {
  return {
    idea_id: 'idea-001',
    score: 7.5,
    per_criterion: { novelty: 8.0, feasibility: 7.0, fit: 8.0, evidence: 7.0 },
    judges_attempted: ['anthropic/claude-sonnet-4-6'],
    judges_skipped: [],
    judge_skipped: false,
    ...over,
  };
}

function brainstormRecord(
  over: Partial<{
    id: string;
    status: string;
    phases: Array<{ phase: string; ranked?: BrainstormRankedIdea[] }>;
    rankings: BrainstormRanking[];
    elaborations: Array<{ idea_id: string; elaboration: string | null; model: string; error?: string }> | null;
    error: string | null;
  }> = {},
) {
  return {
    id: 'bs-mock-id',
    status: 'complete',
    phases: [{ phase: 'idea-rank', ranked: [makeRankedIdea()] }],
    rankings: [makeRanking()],
    elaborations: null,
    error: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// --print-lineup short-circuit
// ---------------------------------------------------------------------------

describe('parliament brainstorm --print-lineup', () => {
  it('prints the brainstorm lineup and makes no HTTP call', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const out = captureStream(process.stdout);

    const { createProgram } = await import('../cli.js');
    const program = createProgram();
    program.configureOutput({ writeOut: () => {}, writeErr: () => {} });

    try {
      await program.parseAsync([
        'node', 'parliament', 'brainstorm', 'a prompt', '--print-lineup',
      ]);
    } finally {
      out.restore();
    }

    expect(fetchSpy).not.toHaveBeenCalled();
    const printed = out.read();
    expect(printed).toContain('Divergent authors:');
    expect(printed).toContain('Judges:');
    expect(printed).toContain('Cluster:');
    expect(printed).toContain('Forge elaborator:');
    expect(printed).toContain('anthropic/claude-opus-4-6');
    expect(printed).toContain('anthropic/claude-sonnet-4-6');
  });
});

// ---------------------------------------------------------------------------
// Happy path — POST + poll
// ---------------------------------------------------------------------------

describe('parliament brainstorm happy path', () => {
  it('POSTs to /brainstorm, polls until complete, and prints ranked ideas', async () => {
    const { posts, gets } = installFetchMock({
      post: { status: 202, body: { id: 'bs-run-1', status: 'running' } },
      gets: [
        { status: 200, body: brainstormRecord({ id: 'bs-run-1', status: 'running', phases: [], rankings: [] }) },
        { status: 200, body: brainstormRecord({ id: 'bs-run-1' }) },
      ],
    });
    const out = captureStream(process.stdout);

    const { createProgram } = await import('../cli.js');
    const program = createProgram();
    program.configureOutput({ writeOut: () => {}, writeErr: () => {} });

    try {
      await program.parseAsync([
        'node', 'parliament', 'brainstorm', 'build a new kind of keyboard',
        '--poll-interval-ms', '100',
      ]);
    } finally {
      out.restore();
    }

    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toMatch(/\/brainstorm$/);
    expect(posts[0]!.body).toEqual({ prompt: 'build a new kind of keyboard' });
    expect(gets.length).toBeGreaterThanOrEqual(1);
    for (const url of gets) {
      expect(url).toMatch(/\/brainstorm\/bs-run-1$/);
    }

    const printed = out.read();
    expect(printed).toContain('Brainstorm bs-run-1 started');
    expect(printed).toContain('--- Ranked Ideas ---');
    expect(printed).toContain('Test Idea');
    expect(printed).toContain('score: 7.50');
  });

  it('forwards --ideas-per-author to the POST body', async () => {
    const { posts } = installFetchMock({
      post: { status: 202, body: { id: 'bs-run-2', status: 'running' } },
      gets: [{ status: 200, body: brainstormRecord({ id: 'bs-run-2' }) }],
    });
    const out = captureStream(process.stdout);

    const { createProgram } = await import('../cli.js');
    const program = createProgram();
    program.configureOutput({ writeOut: () => {}, writeErr: () => {} });

    try {
      await program.parseAsync([
        'node', 'parliament', 'brainstorm', 'cloud storage startup',
        '--ideas-per-author', '8',
        '--poll-interval-ms', '100',
      ]);
    } finally {
      out.restore();
    }

    expect(posts[0]!.body).toEqual({ prompt: 'cloud storage startup', ideas_per_author: 8 });
  });

  it('exits 1 with error message when server returns status=error', async () => {
    installFetchMock({
      post: { status: 202, body: { id: 'bs-run-3', status: 'running' } },
      gets: [
        { status: 200, body: brainstormRecord({ id: 'bs-run-3', status: 'error', error: 'rank phase blew up' }) },
      ],
    });
    const out = captureStream(process.stdout);
    const err = captureStream(process.stderr);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__exit_${code ?? 0}__`);
    }) as never);

    const { createProgram } = await import('../cli.js');
    const program = createProgram();
    program.configureOutput({ writeOut: () => {}, writeErr: () => {} });

    let caught: unknown;
    try {
      await program.parseAsync([
        'node', 'parliament', 'brainstorm', 'will fail',
        '--poll-interval-ms', '100',
      ]);
    } catch (e) {
      caught = e;
    } finally {
      out.restore();
      err.restore();
      exitSpy.mockRestore();
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('__exit_1__');
    expect(err.read()).toContain('rank phase blew up');
  });
});

// ---------------------------------------------------------------------------
// --forge flag
// ---------------------------------------------------------------------------

describe('parliament brainstorm --forge', () => {
  it('POSTs to /brainstorm/forge with default k omitted when --k not set', async () => {
    const { posts } = installFetchMock({
      post: { status: 202, body: { id: 'forge-run-1', status: 'running' } },
      gets: [
        {
          status: 200,
          body: brainstormRecord({
            id: 'forge-run-1',
            elaborations: [
              { idea_id: 'idea-001', elaboration: 'Elaborated content here', model: 'anthropic/claude-opus-4-6' },
            ],
          }),
        },
      ],
    });
    const out = captureStream(process.stdout);

    const { createProgram } = await import('../cli.js');
    const program = createProgram();
    program.configureOutput({ writeOut: () => {}, writeErr: () => {} });

    try {
      await program.parseAsync([
        'node', 'parliament', 'brainstorm', 'build a productivity app',
        '--forge',
        '--poll-interval-ms', '100',
      ]);
    } finally {
      out.restore();
    }

    expect(posts[0]!.url).toMatch(/\/brainstorm\/forge$/);
    // k not set, so not in body
    expect((posts[0]!.body as Record<string, unknown>).k).toBeUndefined();

    const printed = out.read();
    expect(printed).toContain('--- Forge Elaborations ---');
    expect(printed).toContain('Elaborated content here');
  });

  it('forwards --k to the POST body when --forge is set', async () => {
    const { posts } = installFetchMock({
      post: { status: 202, body: { id: 'forge-run-2', status: 'running' } },
      gets: [{ status: 200, body: brainstormRecord({ id: 'forge-run-2', elaborations: [] }) }],
    });
    const out = captureStream(process.stdout);

    const { createProgram } = await import('../cli.js');
    const program = createProgram();
    program.configureOutput({ writeOut: () => {}, writeErr: () => {} });

    try {
      await program.parseAsync([
        'node', 'parliament', 'brainstorm', 'some prompt',
        '--forge', '--k', '5',
        '--poll-interval-ms', '100',
      ]);
    } finally {
      out.restore();
    }

    expect(posts[0]!.url).toMatch(/\/brainstorm\/forge$/);
    expect((posts[0]!.body as Record<string, unknown>).k).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// formatBrainstormLineup helper
// ---------------------------------------------------------------------------

describe('formatBrainstormLineup', () => {
  it('renders all lineup sections', async () => {
    const { formatBrainstormLineup } = await import('../cli.js');
    const out = formatBrainstormLineup(MOCK_LINEUP);
    expect(out).toContain('Divergent authors:');
    expect(out).toContain('Judges:');
    expect(out).toContain('Cluster:');
    expect(out).toContain('Forge elaborator:');
    expect(out).toContain('anthropic/claude-opus-4-6');
    expect(out).toContain('anthropic/claude-sonnet-4-6');
  });
});

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

describe('parliament brainstorm --help', () => {
  it('advertises --forge, --k, --ideas-per-author, and --print-lineup', async () => {
    const { createProgram } = await import('../cli.js');
    const program = createProgram();
    let helpOutput = '';
    program.configureOutput({
      writeOut: (str) => { helpOutput += str; },
      writeErr: () => {},
    });
    program.exitOverride();
    program.commands.forEach((cmd) => {
      cmd.configureOutput({
        writeOut: (str) => { helpOutput += str; },
        writeErr: () => {},
      });
      cmd.exitOverride();
    });

    try {
      await program.parseAsync(['node', 'parliament', 'brainstorm', '--help']);
    } catch {
      // exitOverride throws — ignore.
    }

    expect(helpOutput).toContain('--forge');
    expect(helpOutput).toContain('--k');
    expect(helpOutput).toContain('--ideas-per-author');
    expect(helpOutput).toContain('--print-lineup');
  });
});
