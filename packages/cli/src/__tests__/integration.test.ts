/**
 * CLI integration tests — exercise the real Commander program with the real
 * DeliberationEngine. Only the LLM adapter is stubbed via vi.fn() so the test
 * runs offline.
 *
 * Verifies:
 *   - `parliament deliberate "<topic>"` produces a transcript with all roles
 *     and a final SYNTHESIS line.
 *   - `parliament get <id>` calls the configured server URL via fetch.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ModelAdapter } from '@parliament/core';

// ---------------------------------------------------------------------------
// Mocks: stub createAdapter and loadConfig so the CLI does not touch Ollama.
// ProposerAgent / SkepticAgent / SynthesizerAgent / RedAgent / SentryAgent /
// DeliberationEngine are NOT mocked — we run the real implementations.
// ---------------------------------------------------------------------------

vi.mock('@parliament/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@parliament/core')>();

  let synthIdx = 0;

  const adapter: ModelAdapter = {
    generate: vi.fn(async (_prompt: string, system?: string) => {
      const sys = system ?? '';
      if (/synthesiz/i.test(sys)) {
        synthIdx++;
        return synthIdx >= 2
          ? 'A unifying synthesis emerges. confidence: 0.9'
          : 'Tentative synthesis. confidence: 0.4';
      }
      if (/critic/i.test(sys)) return 'A targeted critique.';
      if (/disruptor/i.test(sys)) return 'A disruption.';
      if (/monitor/i.test(sys)) return 'OK';
      return 'A reasoned proposal on the topic.';
    }),
  };

  return {
    ...actual,
    loadConfig: vi.fn().mockReturnValue({
      neurotypes: {
        proposer: { model: 'llama3.2', system_prompt: '' },
        skeptic: { model: 'mistral', system_prompt: '' },
        synthesizer: { model: 'llama3.2', system_prompt: '' },
        red_agent: { model: 'mistral', system_prompt: '' },
        sentry: { model: 'llama3.2', system_prompt: '' },
      },
    }),
    createAdapter: vi.fn().mockReturnValue(adapter),
  };
});

// ---------------------------------------------------------------------------
// CLI: deliberate command (full real engine)
// ---------------------------------------------------------------------------

describe('parliament deliberate (integration)', () => {
  let stdoutChunks: string[];
  let originalWrite: typeof process.stdout.write;

  beforeEach(() => {
    stdoutChunks = [];
    originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      stdoutChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stdout.write;
  });

  afterEach(() => {
    process.stdout.write = originalWrite;
  });

  it('runs end-to-end and prints a transcript including SYNTHESIS', async () => {
    const { createProgram } = await import('../cli.js');
    const program = createProgram();
    program.configureOutput({ writeOut: () => {}, writeErr: () => {} });

    await program.parseAsync([
      'node',
      'parliament',
      'deliberate',
      'Should we adopt four-day work weeks?',
      '--max-rounds',
      '3',
    ]);

    const output = stdoutChunks.join('');

    // Header includes the topic.
    expect(output).toContain('Should we adopt four-day work weeks?');

    // Transcript shows turn headers for each role we exercised.
    expect(output).toMatch(/PROPOSER/i);
    expect(output).toMatch(/SKEPTIC/i);
    expect(output).toMatch(/SYNTHESIZER/i);

    // Final SYNTHESIS section is present (consensus reached).
    expect(output).toContain('SYNTHESIS');

    // Footer stats are emitted.
    expect(output).toMatch(/Residue score:/);
    expect(output).toMatch(/Termination reason:\s+consensus/);
  });
});

// ---------------------------------------------------------------------------
// CLI: get command — exercises real fetch path against a stubbed Response.
// ---------------------------------------------------------------------------

describe('parliament get (integration)', () => {
  let stdoutChunks: string[];
  let originalWrite: typeof process.stdout.write;
  let fetchSpy: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    stdoutChunks = [];
    originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      stdoutChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stdout.write;

    const fakeBody = {
      topic: 'Persisted topic',
      turns: [
        {
          agent: 'Proposer',
          neurotype: 'structured',
          model: 'llama3.2',
          content: 'fetched content',
          timestamp: '2026-01-01T00:00:00.000Z',
        },
      ],
      conflicts: [],
      residueScore: 0,
      resolved: true,
      synthesis: 'A retrieved synthesis.',
      split: null,
      terminationReason: 'consensus',
      totalRounds: 1,
    };

    originalFetch = globalThis.fetch;
    fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify(fakeBody), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    process.stdout.write = originalWrite;
    globalThis.fetch = originalFetch;
  });

  it('fetches a deliberation by id and prints the transcript', async () => {
    const { createProgram } = await import('../cli.js');
    const program = createProgram();
    program.configureOutput({ writeOut: () => {}, writeErr: () => {} });

    await program.parseAsync(['node', 'parliament', 'get', 'abc-123']);

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\/deliberate\/abc-123$/),
    );

    const output = stdoutChunks.join('');
    expect(output).toContain('Persisted topic');
    expect(output).toContain('A retrieved synthesis.');
  });
});

