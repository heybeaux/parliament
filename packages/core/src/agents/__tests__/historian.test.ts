import { describe, it, expect, vi } from 'vitest';
import type { ModelAdapter } from '../../adapters/base.js';
import type { Blackboard } from '../../types.js';
import { HistorianAgent, HISTORIAN_SYSTEM_PROMPT } from '../historian.js';
import { BUILTIN_AGENT_REGISTRY, createBuiltinAgent } from '../registry.js';

function makeAdapter(response: string): ModelAdapter {
  return { modelName: 'test-model', generate: vi.fn().mockResolvedValue(response) };
}

function makeBlackboard(overrides?: Partial<Blackboard>): Blackboard {
  return {
    topic: 'Should AI systems be regulated?',
    turns: [],
    conflicts: [],
    metadata: {},
    ...overrides,
  };
}

function nWords(n: number): string {
  return Array.from({ length: n }, (_, i) => `word${i}`).join(' ');
}

describe('HistorianAgent', () => {
  it('has role Historian and neurotype historian', () => {
    const agent = new HistorianAgent(makeAdapter('ok'));
    expect(agent.role).toBe('Historian');
    expect(agent.neurotype).toBe('historian');
  });

  it('is registered under the kebab-case id "historian"', () => {
    expect(BUILTIN_AGENT_REGISTRY).toHaveProperty('historian');
    const agent = createBuiltinAgent('historian', makeAdapter('ok'));
    expect(agent.neurotype).toBe('historian');
  });

  it('passes a precedent-focused system prompt to the adapter', async () => {
    const adapter = makeAdapter('The 1996 Telecommunications Act offers a relevant precedent.');
    const agent = new HistorianAgent(adapter);
    await agent.generate(makeBlackboard());

    const [, systemArg] = (adapter.generate as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(systemArg).toBe(HISTORIAN_SYSTEM_PROMPT);
    expect(systemArg).toMatch(/precedent|historical|prior case|what has happened/i);
  });

  it('embeds the topic and recent turns in the user prompt', async () => {
    const adapter = makeAdapter('Reference: GDPR rollout, 2018.');
    const agent = new HistorianAgent(adapter);
    const board = makeBlackboard({
      turns: [
        { agent: 'Proposer', neurotype: 'structured', model: 'test', content: 'Regulators should move now.', timestamp: '', round: 1 },
      ],
    });
    await agent.generate(board);

    const [userPrompt] = (adapter.generate as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(userPrompt).toContain('Should AI systems be regulated?');
    expect(userPrompt).toContain('Regulators should move now.');
  });

  it('returns the adapter response as content with truncated=false when under cap', async () => {
    const reply = 'The 1996 Telecommunications Act is a relevant precedent for AI oversight.';
    const agent = new HistorianAgent(makeAdapter(reply));
    const result = await agent.generate(makeBlackboard());

    expect(result.content).toBe(reply);
    expect(result.truncated).toBe(false);
  });

  it('enforces the 200-word cap and sets truncated=true', async () => {
    const longResponse = nWords(250);
    const agent = new HistorianAgent(makeAdapter(longResponse));
    const result = await agent.generate(makeBlackboard());

    expect(result.truncated).toBe(true);
    expect(result.content.split(/\s+/).length).toBe(200);
  });

  it('preserves an explicit "no clear historical precedent" disclaimer when the model emits it', async () => {
    const reply = 'There is no clear historical precedent for autonomous self-improving systems at this scale.';
    const agent = new HistorianAgent(makeAdapter(reply));
    const result = await agent.generate(makeBlackboard({ topic: 'Should fully autonomous self-improving AI be permitted?' }));

    expect(result.content).toContain('no clear historical precedent');
    expect(result.truncated).toBe(false);
  });

  it('produces a non-empty turn from a stub adapter', async () => {
    const reply = 'Precedent: the 1986 Chernobyl response demonstrates the cost of delayed regulation.';
    const agent = new HistorianAgent(makeAdapter(reply));
    const result = await agent.generate(makeBlackboard());

    expect(result.content.length).toBeGreaterThan(0);
    expect(result.content).toMatch(/precedent|1986|Chernobyl/i);
  });
});
