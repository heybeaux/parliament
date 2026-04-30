import { describe, it, expect, vi } from 'vitest';
import type { ModelAdapter } from '../../adapters/base.js';
import type { Blackboard } from '../../types.js';
import { LateralistAgent, LATERALIST_SYSTEM_PROMPT } from '../lateralist.js';
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

describe('LateralistAgent', () => {
  it('has role Lateralist and neurotype lateralist', () => {
    const agent = new LateralistAgent(makeAdapter('ok'));
    expect(agent.role).toBe('Lateralist');
    expect(agent.neurotype).toBe('lateralist');
  });

  it('is registered under the kebab-case id "lateralist"', () => {
    expect(BUILTIN_AGENT_REGISTRY).toHaveProperty('lateralist');
    const agent = createBuiltinAgent('lateralist', makeAdapter('ok'));
    expect(agent.neurotype).toBe('lateralist');
  });

  it('passes the analogy-posture system prompt to the adapter', async () => {
    const adapter = makeAdapter('ok');
    const agent = new LateralistAgent(adapter);
    await agent.generate(makeBlackboard());

    const [, systemArg] = (adapter.generate as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(systemArg).toBe(LATERALIST_SYSTEM_PROMPT);
    expect(systemArg).toMatch(/structural shape/i);
    expect(systemArg).toMatch(/this is a/i);
    expect(systemArg).toMatch(/analogy|analogous/i);
    // Must instruct on cross-domain difference.
    expect(systemArg).toMatch(/different domain|cross-domain|materially different/i);
  });

  it('embeds the topic and recent turns in the user prompt', async () => {
    const adapter = makeAdapter('this is a measurement problem; analogous to early thermometry.');
    const agent = new LateralistAgent(adapter);
    const board = makeBlackboard({
      turns: [
        { agent: 'Proposer', neurotype: 'structured', model: 'test', content: 'Regulators should grade model risk.', timestamp: '', round: 1 },
      ],
    });
    await agent.generate(board);

    const [userPrompt] = (adapter.generate as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(userPrompt).toContain('Should AI systems be regulated?');
    expect(userPrompt).toContain('Regulators should grade model risk.');
  });

  it('returns adapter response as content with truncated=false when under cap', async () => {
    const reply = 'this is a coordination problem; analogous to the early days of maritime collision rules.';
    const agent = new LateralistAgent(makeAdapter(reply));
    const result = await agent.generate(makeBlackboard());

    expect(result.content).toBe(reply);
    expect(result.truncated).toBe(false);
  });

  it('enforces the 200-word cap and sets truncated=true', async () => {
    const longResponse = nWords(250);
    const agent = new LateralistAgent(makeAdapter(longResponse));
    const result = await agent.generate(makeBlackboard());

    expect(result.truncated).toBe(true);
    expect(result.content.split(/\s+/).length).toBe(200);
  });

  it('preserves the literal "this is a <class> problem" structural label when the model emits it', async () => {
    const reply = 'this is a measurement problem at heart; the rule is only as good as the metric.';
    const agent = new LateralistAgent(makeAdapter(reply));
    const result = await agent.generate(makeBlackboard());

    expect(result.content.toLowerCase()).toMatch(/this is a [a-z\-]+ problem/);
  });

  it('preserves a cross-domain analogy when the model emits one', async () => {
    const reply =
      'this is a commons problem. The closest analogy is North Atlantic fisheries before quota systems: rational individual behaviour produces collective collapse, ' +
      'and the fix was not exhortation but enforceable, monitored quotas.';
    const agent = new LateralistAgent(makeAdapter(reply));
    const result = await agent.generate(makeBlackboard());

    expect(result.content.toLowerCase()).toMatch(/analog(y|ous)/);
    // Cross-domain: a non-AI domain (fisheries) is named explicitly.
    expect(result.content).toMatch(/fisheries|fishing|maritime/i);
  });
});
