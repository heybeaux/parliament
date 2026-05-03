/**
 * PAR-31: regression test for the CLI dropping the `provider` arg when
 * constructing structural agents (synthesizer, redAgent, sentry) and the
 * legacy-path proposer/skeptic. Pre-fix, those callsites passed only `model`
 * to `createAdapter`, forcing the Ollama default regardless of TOML.
 *
 * Strategy: mock `createAdapter` with `vi.fn` (not `mockReturnValue`) so we
 * can capture every call and assert each agent's TOML-declared `provider`
 * was threaded through.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AdapterResult, ModelAdapter } from '@parliament/core';

vi.mock('@parliament/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@parliament/core')>();

  let synthIdx = 0;
  const adapter: ModelAdapter = {
    modelName: 'mock',
    generate: vi.fn(async (_p: string, system?: string): Promise<AdapterResult> => {
      const sys = system ?? '';
      if (/synthesiz/i.test(sys)) {
        synthIdx++;
        return {
          content: JSON.stringify({
            summary: 's',
            confidence: synthIdx >= 2 ? 0.9 : 0.4,
            consensus: synthIdx >= 2,
            agreed: [],
            unresolved: synthIdx >= 2 ? [] : ['x'],
          }),
        };
      }
      if (/critic/i.test(sys)) return { content: 'c' };
      if (/disruptor/i.test(sys)) return { content: 'd' };
      if (/monitor/i.test(sys)) return { content: 'OK' };
      return { content: 'p' };
    }),
  };

  return {
    ...actual,
    loadConfig: vi.fn().mockReturnValue({
      neurotypes: {
        proposer: { model: 'qwen/qwen-turbo', provider: 'openrouter', system_prompt: '' },
        skeptic: { model: 'deepseek/deepseek-v4-flash', provider: 'openrouter', system_prompt: '' },
        synthesizer: { model: 'nvidia/nemotron-nano-9b-v2', provider: 'openrouter', system_prompt: '' },
        redAgent: { model: 'x-ai/grok-4.1-fast', provider: 'openrouter', system_prompt: '' },
        sentry: { model: 'mistralai/mistral-nemo', provider: 'openrouter', system_prompt: '' },
      },
    }),
    createAdapter: vi.fn(() => adapter),
  };
});

describe('CLI: createAdapter receives neurotype.provider for every agent', () => {
  let originalWrite: typeof process.stdout.write;

  beforeEach(() => {
    originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (() => true) as typeof process.stdout.write;
  });

  afterEach(() => {
    process.stdout.write = originalWrite;
  });

  it('legacy debate path: proposer, skeptic, synthesizer, redAgent, sentry all get provider="openrouter"', async () => {
    const { createAdapter } = await import('@parliament/core');
    const { createProgram } = await import('../cli.js');

    const program = createProgram();
    program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    await program.parseAsync([
      'node',
      'parliament',
      'deliberate',
      'topic',
      '--max-rounds',
      '2',
    ]);

    // Every call to createAdapter must include the provider arg.
    const mock = createAdapter as unknown as ReturnType<typeof vi.fn>;
    expect(mock.mock.calls.length).toBeGreaterThanOrEqual(5);
    for (const call of mock.mock.calls) {
      expect(call[1]).toBe('openrouter');
    }

    // And the model from each neurotype is the correct one.
    const modelsCalled = mock.mock.calls.map((c: unknown[]) => c[0]);
    expect(modelsCalled).toContain('qwen/qwen-turbo');
    expect(modelsCalled).toContain('deepseek/deepseek-v4-flash');
    expect(modelsCalled).toContain('nvidia/nemotron-nano-9b-v2');
    expect(modelsCalled).toContain('x-ai/grok-4.1-fast');
    expect(modelsCalled).toContain('mistralai/mistral-nemo');
  });
});
