import { describe, it, expect, vi } from 'vitest';
import type { ModelAdapter } from '../../adapters/base.js';
import type { Blackboard } from '../../types.js';
import { ForecasterAgent, FORECASTER_SYSTEM_PROMPT } from '../forecaster.js';
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

describe('ForecasterAgent', () => {
  it('has role Forecaster and neurotype forecaster', () => {
    const agent = new ForecasterAgent(makeAdapter('ok'));
    expect(agent.role).toBe('Forecaster');
    expect(agent.neurotype).toBe('forecaster');
  });

  it('is registered under the kebab-case id "forecaster"', () => {
    expect(BUILTIN_AGENT_REGISTRY).toHaveProperty('forecaster');
    const agent = createBuiltinAgent('forecaster', makeAdapter('ok'));
    expect(agent.neurotype).toBe('forecaster');
  });

  it('passes the forecaster system prompt to the adapter and instructs on multiple time horizons', async () => {
    const adapter = makeAdapter('Near-term: compliance burden. Longer-term: market consolidation.');
    const agent = new ForecasterAgent(adapter);
    await agent.generate(makeBlackboard());

    const [, systemArg] = (adapter.generate as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(systemArg).toBe(FORECASTER_SYSTEM_PROMPT);
    expect(systemArg).toMatch(/near-term/i);
    expect(systemArg).toMatch(/longer-term/i);
    expect(systemArg).toMatch(/two distinct time horizons/i);
  });

  it('embeds the topic and recent turns in the user prompt', async () => {
    const adapter = makeAdapter('Near-term and longer-term consequences sketched.');
    const agent = new ForecasterAgent(adapter);
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

  it('returns adapter response as content with truncated=false when under cap', async () => {
    const reply = 'Near-term: compliance friction. Longer-term: incumbent advantage hardens.';
    const agent = new ForecasterAgent(makeAdapter(reply));
    const result = await agent.generate(makeBlackboard());

    expect(result.content).toBe(reply);
    expect(result.truncated).toBe(false);
  });

  it('enforces the 200-word cap and sets truncated=true', async () => {
    const longResponse = nWords(250);
    const agent = new ForecasterAgent(makeAdapter(longResponse));
    const result = await agent.generate(makeBlackboard());

    expect(result.truncated).toBe(true);
    expect(result.content.split(/\s+/).length).toBe(200);
  });

  it('preserves an explicit "would invalidate the claim" flag when the model emits it', async () => {
    const reply = 'Longer-term, runaway capability gains would invalidate the claim that current rules suffice.';
    const agent = new ForecasterAgent(makeAdapter(reply));
    const result = await agent.generate(makeBlackboard());

    expect(result.content).toContain('would invalidate the claim');
  });

  it('produces a non-empty turn referencing both time horizons when the model cooperates', async () => {
    const reply = 'Near-term, compliance overhead rises. Longer-term, monopolies consolidate around early licensees.';
    const agent = new ForecasterAgent(makeAdapter(reply));
    const result = await agent.generate(makeBlackboard());

    expect(result.content.length).toBeGreaterThan(0);
    expect(result.content).toMatch(/near-term/i);
    expect(result.content).toMatch(/longer-term/i);
  });
});
