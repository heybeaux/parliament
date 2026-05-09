/**
 * CLI `ideate` command tests.
 *
 * Pins the wire shape of the CLI -> server contract for /ideate:
 *   - --print-lineup short-circuits before any HTTP call.
 *   - --mode=full requires either --yes or an interactive y/N reply.
 *   - Happy path POSTs the body, then polls GET /ideate/:id until terminal.
 *   - Server `error` status surfaces on stderr with a non-zero exit.
 *
 * Strategy:
 *   - Mock @parliament/core to provide loadConfig + resolveLineup without
 *     touching real config/file IO.
 *   - Mock global.fetch to script the POST + GET responses inline.
 *   - Mock ./display.js for parity with the existing CLI test suite.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ResolvedLineup, IdeationRecord, PhaseRecord } from '@parliament/core';

// ---------------------------------------------------------------------------
// Mocks — hoisted
// ---------------------------------------------------------------------------

const MOCK_LINEUP: ResolvedLineup = {
  mode: 'cooperative',
  synth: 'anthropic/claude-opus-4-6',
  team: {
    cooperative: [
      { role: 'proposer', model: 'anthropic/claude-opus-4-6' },
      { role: 'expander', model: 'openai/gpt-5' },
      { role: 'pragmatist', model: 'google/gemini-2.5-pro' },
      { role: 'lateralist', model: 'x-ai/grok-4' },
    ],
    adversarial: [],
  },
};

const MOCK_FULL_LINEUP: ResolvedLineup = {
  mode: 'full',
  synth: 'google/gemini-2.5-pro',
  team: {
    cooperative: [
      { role: 'proposer', model: 'anthropic/claude-opus-4-6' },
      { role: 'expander', model: 'openai/gpt-5' },
      { role: 'pragmatist', model: 'google/gemini-2.5-pro' },
      { role: 'lateralist', model: 'x-ai/grok-4' },
    ],
    adversarial: [
      { role: 'skeptic', model: 'anthropic/claude-opus-4-6' },
      { role: 'devils-advocate', model: 'openai/gpt-5' },
    ],
  },
};

vi.mock('@parliament/core', () => ({
  loadConfig: vi.fn().mockReturnValue({
    neurotypes: {},
    ideate: {},
  }),
  resolveLineup: vi.fn().mockImplementation((mode: string) => {
    if (mode === 'full') return MOCK_FULL_LINEUP;
    return { ...MOCK_LINEUP, mode };
  }),
  // The CLI's runDeliberate path also imports these — keep them stubbed so
  // module load doesn't trip on missing exports.
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
      gets.push(url);
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

function ideationRecord(over: Partial<IdeationRecord> = {}): IdeationRecord {
  return {
    id: 'mock-id',
    created_at: '2026-05-07T00:00:00.000Z',
    idea: 'mock idea',
    mode: 'cooperative',
    style: 'collective',
    status: 'complete',
    lineup: MOCK_LINEUP,
    phases: [],
    synthesis: 'final synthesis',
    error: null,
    ...over,
  };
}

function completePhase(): PhaseRecord {
  return {
    phase: 'synth',
    contributions: [
      {
        role: 'synthesizer',
        model: 'anthropic/claude-opus-4-6',
        content: 'final synthesis',
        timestamp: '2026-05-07T00:00:30.000Z',
      },
    ],
    synthesis: 'final synthesis',
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

describe('parliament ideate --print-lineup', () => {
  it('prints the lineup and makes no HTTP call', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const out = captureStream(process.stdout);

    const { createProgram } = await import('../cli.js');
    const program = createProgram();
    program.configureOutput({ writeOut: () => {}, writeErr: () => {} });

    try {
      await program.parseAsync(['node', 'parliament', 'ideate', 'an idea', '--print-lineup']);
    } finally {
      out.restore();
    }

    expect(fetchSpy).not.toHaveBeenCalled();
    const printed = out.read();
    expect(printed).toContain('Mode:');
    expect(printed).toContain('Synthesizer:');
    expect(printed).toContain('Cooperative team:');
    expect(printed).toContain('proposer');
    expect(printed).toContain('anthropic/claude-opus-4-6');
  });

  it('prints adversarial team when mode=full', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const out = captureStream(process.stdout);

    const { createProgram } = await import('../cli.js');
    const program = createProgram();
    program.configureOutput({ writeOut: () => {}, writeErr: () => {} });

    try {
      await program.parseAsync([
        'node', 'parliament', 'ideate', 'an idea',
        '--mode', 'full', '--print-lineup',
      ]);
    } finally {
      out.restore();
    }

    expect(fetchSpy).not.toHaveBeenCalled();
    const printed = out.read();
    expect(printed).toContain('Adversarial team:');
    expect(printed).toContain('skeptic');
    expect(printed).toContain('devils-advocate');
  });
});

// ---------------------------------------------------------------------------
// --mode=full confirm gate
// ---------------------------------------------------------------------------

describe('parliament ideate --mode=full confirm gate', () => {
  it('passes confirm:true in the POST body when --yes is set', async () => {
    const { posts } = installFetchMock({
      post: { status: 202, body: { id: 'abc-123', status: 'running' } },
      gets: [
        { status: 200, body: ideationRecord({ id: 'abc-123', mode: 'full', phases: [completePhase()] }) },
      ],
    });
    const out = captureStream(process.stdout);

    const { createProgram } = await import('../cli.js');
    const program = createProgram();
    program.configureOutput({ writeOut: () => {}, writeErr: () => {} });

    try {
      await program.parseAsync([
        'node', 'parliament', 'ideate', 'big run',
        '--mode', 'full', '--yes',
        '--poll-interval-ms', '100',
      ]);
    } finally {
      out.restore();
    }

    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toEqual({
      idea: 'big run',
      mode: 'full',
      style: 'collective',
      confirm: true,
    });
  });

  it('cancels without POSTing when --mode=full has no --yes and the user replies "n"', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const out = captureStream(process.stdout);

    // Simulate stdin "n\n" by emitting a data event after the prompt is awaited.
    const stdin = process.stdin as NodeJS.ReadStream & { emit: (...a: unknown[]) => boolean };
    const resumeSpy = vi.spyOn(stdin, 'resume').mockImplementation(() => stdin);
    const pauseSpy = vi.spyOn(stdin, 'pause').mockImplementation(() => stdin);
    const onceSpy = vi
      .spyOn(stdin, 'once')
      .mockImplementation(((event: string | symbol, listener: (...args: unknown[]) => void) => {
        if (event === 'data') {
          // Fire on the next tick so promptYesNo's resolver wires up first.
          setImmediate(() => listener(Buffer.from('n\n')));
        }
        return stdin;
      }) as unknown as typeof stdin.once);
    const removeListenerSpy = vi
      .spyOn(stdin, 'removeListener')
      .mockImplementation(() => stdin);

    const { createProgram } = await import('../cli.js');
    const program = createProgram();
    program.configureOutput({ writeOut: () => {}, writeErr: () => {} });

    try {
      await program.parseAsync([
        'node', 'parliament', 'ideate', 'big run',
        '--mode', 'full',
      ]);
    } finally {
      out.restore();
      resumeSpy.mockRestore();
      pauseSpy.mockRestore();
      onceSpy.mockRestore();
      removeListenerSpy.mockRestore();
    }

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(out.read()).toContain('cancelled');
  });
});

// ---------------------------------------------------------------------------
// Happy path — POST + poll
// ---------------------------------------------------------------------------

describe('parliament ideate happy path', () => {
  it('POSTs the idea, polls until status=complete, and prints the synthesis', async () => {
    const { posts, gets } = installFetchMock({
      post: { status: 202, body: { id: 'run-1', status: 'running' } },
      gets: [
        { status: 200, body: ideationRecord({ id: 'run-1', status: 'running', phases: [], synthesis: null }) },
        { status: 200, body: ideationRecord({ id: 'run-1', status: 'complete', phases: [completePhase()] }) },
      ],
    });
    const out = captureStream(process.stdout);

    const { createProgram } = await import('../cli.js');
    const program = createProgram();
    program.configureOutput({ writeOut: () => {}, writeErr: () => {} });

    try {
      await program.parseAsync([
        'node', 'parliament', 'ideate', 'a fresh idea',
        '--poll-interval-ms', '100',
      ]);
    } finally {
      out.restore();
    }

    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toMatch(/\/ideate$/);
    expect(posts[0]!.body).toEqual({
      idea: 'a fresh idea',
      mode: 'cooperative',
      style: 'collective',
    });
    expect(gets.length).toBeGreaterThanOrEqual(1);
    for (const url of gets) {
      expect(url).toMatch(/\/ideate\/run-1$/);
    }

    const printed = out.read();
    expect(printed).toContain('Ideation run-1 started');
    expect(printed).toContain('--- Synthesis ---');
    expect(printed).toContain('final synthesis');
  });

  it('exits 1 with the server error when the run finalises as status=error', async () => {
    installFetchMock({
      post: { status: 202, body: { id: 'run-2', status: 'running' } },
      gets: [
        { status: 200, body: ideationRecord({ id: 'run-2', status: 'error', synthesis: null, error: 'adapter blew up' }) },
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
        'node', 'parliament', 'ideate', 'will fail',
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
    expect(err.read()).toContain('adapter blew up');
  });
});

// ---------------------------------------------------------------------------
// formatLineup helper
// ---------------------------------------------------------------------------

describe('formatLineup', () => {
  it('renders cooperative-only lineup without an adversarial section', async () => {
    const { formatLineup } = await import('../cli.js');
    const out = formatLineup(MOCK_LINEUP);
    expect(out).toContain('Mode:        cooperative');
    expect(out).toContain('Synthesizer: anthropic/claude-opus-4-6');
    expect(out).toContain('Cooperative team:');
    expect(out).not.toContain('Adversarial team:');
  });

  it('includes adversarial section when team has entries', async () => {
    const { formatLineup } = await import('../cli.js');
    const out = formatLineup(MOCK_FULL_LINEUP);
    expect(out).toContain('Adversarial team:');
    expect(out).toContain('skeptic');
    expect(out).toContain('devils-advocate');
  });
});

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

describe('parliament ideate --help', () => {
  it('advertises --mode, --style, --yes, and --print-lineup', async () => {
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
      await program.parseAsync(['node', 'parliament', 'ideate', '--help']);
    } catch {
      // exitOverride throws — ignore.
    }

    expect(helpOutput).toContain('--mode');
    expect(helpOutput).toContain('--style');
    expect(helpOutput).toContain('--yes');
    expect(helpOutput).toContain('--print-lineup');
    // PAR-Lattice flags appear in help so users discover them naturally.
    expect(helpOutput).toContain('--lattice');
    expect(helpOutput).toContain('--audit-log');
  });
});

// ---------------------------------------------------------------------------
// PAR-Lattice — --lattice / --audit-log flags
//
// The CLI flags marshal a structured `lattice` block onto the POST body. The
// orchestrator/server interpret it; here we just pin the wire shape.
// ---------------------------------------------------------------------------

describe('parliament ideate --lattice', () => {
  it('default (no flag) omits the lattice block from the POST body', async () => {
    const { posts } = installFetchMock({
      post: { status: 202, body: { id: 'abc-1', status: 'running' } },
      gets: [{ status: 200, body: ideationRecord({ id: 'abc-1' }) }],
    });
    const out = captureStream(process.stdout);

    const { createProgram } = await import('../cli.js');
    const program = createProgram();
    program.configureOutput({ writeOut: () => {}, writeErr: () => {} });

    try {
      await program.parseAsync([
        'node', 'parliament', 'ideate', 'an idea',
        '--poll-interval-ms', '100',
      ]);
    } finally {
      out.restore();
    }

    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toEqual({
      idea: 'an idea',
      mode: 'cooperative',
      style: 'collective',
    });
    // Body must not carry a lattice key when the flag is absent.
    expect((posts[0]!.body as Record<string, unknown>).lattice).toBeUndefined();
  });

  it('--lattice sends { enabled: true, auditLogPath: default } when no --audit-log', async () => {
    const { posts } = installFetchMock({
      post: { status: 202, body: { id: 'abc-2', status: 'running' } },
      gets: [{ status: 200, body: ideationRecord({ id: 'abc-2' }) }],
    });
    const out = captureStream(process.stdout);

    const { createProgram } = await import('../cli.js');
    const program = createProgram();
    program.configureOutput({ writeOut: () => {}, writeErr: () => {} });

    try {
      await program.parseAsync([
        'node', 'parliament', 'ideate', 'an idea',
        '--lattice',
        '--poll-interval-ms', '100',
      ]);
    } finally {
      out.restore();
    }

    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toMatchObject({
      idea: 'an idea',
      mode: 'cooperative',
      style: 'collective',
      lattice: { enabled: true, auditLogPath: './parliament-audit.jsonl' },
    });
  });

  it('--lattice with --audit-log forwards the supplied path verbatim', async () => {
    const { posts } = installFetchMock({
      post: { status: 202, body: { id: 'abc-3', status: 'running' } },
      gets: [{ status: 200, body: ideationRecord({ id: 'abc-3' }) }],
    });
    const out = captureStream(process.stdout);

    const { createProgram } = await import('../cli.js');
    const program = createProgram();
    program.configureOutput({ writeOut: () => {}, writeErr: () => {} });

    try {
      await program.parseAsync([
        'node', 'parliament', 'ideate', 'an idea',
        '--lattice',
        '--audit-log', '/tmp/custom-audit.jsonl',
        '--poll-interval-ms', '100',
      ]);
    } finally {
      out.restore();
    }

    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toMatchObject({
      lattice: { enabled: true, auditLogPath: '/tmp/custom-audit.jsonl' },
    });
  });

  it('--audit-log without --lattice warns on stderr and omits the lattice block', async () => {
    const { posts } = installFetchMock({
      post: { status: 202, body: { id: 'abc-4', status: 'running' } },
      gets: [{ status: 200, body: ideationRecord({ id: 'abc-4' }) }],
    });
    const out = captureStream(process.stdout);
    const err = captureStream(process.stderr);

    const { createProgram } = await import('../cli.js');
    const program = createProgram();
    program.configureOutput({ writeOut: () => {}, writeErr: () => {} });

    try {
      await program.parseAsync([
        'node', 'parliament', 'ideate', 'an idea',
        '--audit-log', '/tmp/orphan.jsonl',
        '--poll-interval-ms', '100',
      ]);
    } finally {
      out.restore();
      err.restore();
    }

    expect(err.read()).toContain('--audit-log requires --lattice=true');
    expect((posts[0]!.body as Record<string, unknown>).lattice).toBeUndefined();
  });

  it('prints a one-line Lattice summary when the record carries a lattice report', async () => {
    const latticeReport = {
      enabled: true,
      traceId: '01TEST_TRACE',
      agreementRatio: 0.75,
      consensusReached: true,
      conflicts: [],
      modelOutcomes: [
        { agentId: 'm1', role: 'proposer', isAdversarial: false, passed: true, breakerTier: 'L1+L2' as const },
      ],
      auditLogPath: './parliament-audit.jsonl',
    };
    const { posts } = installFetchMock({
      post: { status: 202, body: { id: 'abc-5', status: 'running' } },
      gets: [
        { status: 200, body: ideationRecord({ id: 'abc-5', lattice: latticeReport }) },
      ],
    });
    const out = captureStream(process.stdout);

    const { createProgram } = await import('../cli.js');
    const program = createProgram();
    program.configureOutput({ writeOut: () => {}, writeErr: () => {} });

    try {
      await program.parseAsync([
        'node', 'parliament', 'ideate', 'an idea',
        '--lattice',
        '--poll-interval-ms', '100',
      ]);
    } finally {
      out.restore();
    }

    expect(posts).toHaveLength(1);
    const printed = out.read();
    expect(printed).toContain('Lattice: trace=01TEST_TRACE');
    expect(printed).toContain('agreement=0.75');
    expect(printed).toContain('consensus=yes');
    expect(printed).toContain('conflicts=0');
    expect(printed).toContain('audit=./parliament-audit.jsonl');
  });
});
