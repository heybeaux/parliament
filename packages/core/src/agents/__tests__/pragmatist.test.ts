import { describe, it, expect, vi } from 'vitest';
import type { ModelAdapter } from '../../adapters/base.js';
import type { Blackboard } from '../../types.js';
import { PragmatistAgent, PRAGMATIST_SYSTEM_PROMPT } from '../pragmatist.js';
import { BUILTIN_AGENT_REGISTRY, createBuiltinAgent } from '../registry.js';

function makeAdapter(response: string): ModelAdapter {
  return { modelName: 'test-model', generate: vi.fn().mockResolvedValue({ content: response }) };
}

function makeBlackboard(overrides?: Partial<Blackboard>): Blackboard {
  return {
    topic: 'Should the EU mandate end-to-end encryption for messaging?',
    turns: [],
    conflicts: [],
    metadata: {},
    ...overrides,
  };
}

function nWords(n: number): string {
  return Array.from({ length: n }, (_, i) => `word${i}`).join(' ');
}

describe('PragmatistAgent', () => {
  it('has role Pragmatist and neurotype pragmatist', () => {
    const agent = new PragmatistAgent(makeAdapter('ok'));
    expect(agent.role).toBe('Pragmatist');
    expect(agent.neurotype).toBe('pragmatist');
  });

  it('is registered under the kebab-case id "pragmatist"', () => {
    expect(BUILTIN_AGENT_REGISTRY).toHaveProperty('pragmatist');
    const agent = createBuiltinAgent('pragmatist', makeAdapter('ok'));
    expect(agent.neurotype).toBe('pragmatist');
  });

  it('passes the constraint-first system prompt to the adapter', async () => {
    const adapter = makeAdapter('ok');
    const agent = new PragmatistAgent(adapter);
    await agent.generate(makeBlackboard());

    const [, systemArg] = (adapter.generate as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(systemArg).toBe(PRAGMATIST_SYSTEM_PROMPT);
    expect(systemArg).toMatch(/binding constraint/i);
    expect(systemArg).toMatch(/minimum viable variant/i);
    expect(systemArg).toMatch(/feasibility|doable|actually doable/i);
  });

  it('embeds the topic and recent turns in the user prompt', async () => {
    const adapter = makeAdapter('Resources are the binding constraint.');
    const agent = new PragmatistAgent(adapter);
    const board = makeBlackboard({
      turns: [
        { agent: 'Proposer', neurotype: 'structured', model: 'test', content: 'Mandate strong encryption now.', timestamp: '', round: 1 },
      ],
    });
    await agent.generate(board);

    const [userPrompt] = (adapter.generate as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(userPrompt).toContain('Should the EU mandate end-to-end encryption for messaging?');
    expect(userPrompt).toContain('Mandate strong encryption now.');
  });

  it('returns adapter response as content with truncated=false when under cap', async () => {
    const reply = 'The binding constraint is enforcement capacity in member states.';
    const agent = new PragmatistAgent(makeAdapter(reply));
    const result = await agent.generate(makeBlackboard());

    expect(result.content).toBe(reply);
    expect(result.truncated).toBe(false);
  });

  it('enforces the 200-word cap and sets truncated=true', async () => {
    const longResponse = nWords(250);
    const agent = new PragmatistAgent(makeAdapter(longResponse));
    const result = await agent.generate(makeBlackboard());

    expect(result.truncated).toBe(true);
    expect(result.content.split(/\s+/).length).toBe(200);
  });

  it('preserves an explicit "binding constraint" naming when the model emits it', async () => {
    const reply = 'The binding constraint is law-enforcement access; without a key-escrow scheme, mandates stall politically.';
    const agent = new PragmatistAgent(makeAdapter(reply));
    const result = await agent.generate(makeBlackboard());

    expect(result.content).toContain('binding constraint');
  });

  it('preserves a "minimum viable variant" suggestion when the model offers one', async () => {
    const reply = 'Maximalist mandate is infeasible; a minimum viable variant scopes the rule to consumer messaging only and exempts enterprise tooling.';
    const agent = new PragmatistAgent(makeAdapter(reply));
    const result = await agent.generate(makeBlackboard());

    expect(result.content).toContain('minimum viable variant');
  });
});
