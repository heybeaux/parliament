import { describe, it, expect, vi } from 'vitest';
import type { ModelAdapter } from '../../adapters/base.js';
import type { Blackboard } from '../../types.js';
import { EmpiricistAgent, EMPIRICIST_SYSTEM_PROMPT } from '../empiricist.js';
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

describe('EmpiricistAgent', () => {
  it('has role Empiricist and neurotype empiricist', () => {
    const agent = new EmpiricistAgent(makeAdapter('ok'));
    expect(agent.role).toBe('Empiricist');
    expect(agent.neurotype).toBe('empiricist');
  });

  it('is registered under the kebab-case id "empiricist"', () => {
    expect(BUILTIN_AGENT_REGISTRY).toHaveProperty('empiricist');
    const agent = createBuiltinAgent('empiricist', makeAdapter('ok'));
    expect(agent.neurotype).toBe('empiricist');
  });

  it('passes the evidence-first system prompt to the adapter', async () => {
    const adapter = makeAdapter('ok');
    const agent = new EmpiricistAgent(adapter);
    await agent.generate(makeBlackboard());

    const [, systemArg] = (adapter.generate as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(systemArg).toBe(EMPIRICIST_SYSTEM_PROMPT);
    expect(systemArg).toMatch(/demand evidence/i);
    expect(systemArg).toMatch(/value judgment, not an empirical one/i);
    // Elaboration decision: do NOT reject value-judgment claims.
    expect(systemArg).toMatch(/do NOT reject/i);
  });

  it('embeds the topic and recent turns in the user prompt', async () => {
    const adapter = makeAdapter('Demand evidence: cite the underlying study.');
    const agent = new EmpiricistAgent(adapter);
    const board = makeBlackboard({
      turns: [
        { agent: 'Proposer', neurotype: 'structured', model: 'test', content: 'Regulation reduces harm by 40%.', timestamp: '', round: 1 },
      ],
    });
    await agent.generate(board);

    const [userPrompt] = (adapter.generate as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(userPrompt).toContain('Should AI systems be regulated?');
    expect(userPrompt).toContain('Regulation reduces harm by 40%.');
  });

  it('returns adapter response as content with truncated=false when under cap', async () => {
    const reply = 'Demand evidence for the 40% claim — name the dataset.';
    const agent = new EmpiricistAgent(makeAdapter(reply));
    const result = await agent.generate(makeBlackboard());

    expect(result.content).toBe(reply);
    expect(result.truncated).toBe(false);
  });

  it('enforces the 200-word cap and sets truncated=true', async () => {
    const longResponse = nWords(250);
    const agent = new EmpiricistAgent(makeAdapter(longResponse));
    const result = await agent.generate(makeBlackboard());

    expect(result.truncated).toBe(true);
    expect(result.content.split(/\s+/).length).toBe(200);
  });

  it('demands evidence on an unsupported empirical claim', async () => {
    const reply = 'Demand evidence: which study supports the claim that "regulation reduces harm by 40%"? Without a citable dataset this is unsupported.';
    const agent = new EmpiricistAgent(makeAdapter(reply));
    const board = makeBlackboard({
      turns: [
        { agent: 'Proposer', neurotype: 'structured', model: 'test', content: 'Regulation reduces harm by 40%.', timestamp: '', round: 1 },
      ],
    });
    const result = await agent.generate(board);

    expect(result.content).toMatch(/demand evidence/i);
    expect(result.content).toMatch(/study|dataset|citable/i);
  });

  it('flags a value-judgment claim as unfalsifiable but does NOT reject it', async () => {
    // Elaboration decision: empiricist labels value judgments as unfalsifiable
    // but allows them to remain in the deliberation. Output should contain the
    // explicit label and should NOT contain rejection language.
    const reply =
      '"Privacy is more important than convenience" — this claim is a value judgment, not an empirical one. ' +
      'No measurement would settle it. I leave it standing in the transcript so the deliberation can weigh it on its own terms.';
    const agent = new EmpiricistAgent(makeAdapter(reply));
    const board = makeBlackboard({
      topic: 'Should privacy override convenience in product defaults?',
      turns: [
        { agent: 'Proposer', neurotype: 'structured', model: 'test', content: 'Privacy is more important than convenience.', timestamp: '', round: 1 },
      ],
    });
    const result = await agent.generate(board);

    expect(result.content).toContain('this claim is a value judgment, not an empirical one');
    // Hard non-rejection: the agent must NOT call the claim invalid / out of scope / dismissed.
    expect(result.content).not.toMatch(/\b(reject|invalid|out of scope|dismiss(ed|al)?)\b/i);
  });

  it('produces a non-empty turn even when the topic is purely value-laden', async () => {
    const reply =
      '"Justice matters more than efficiency" — this claim is a value judgment, not an empirical one. ' +
      'I will not seek evidence against it; I record the limitation and yield the floor.';
    const agent = new EmpiricistAgent(makeAdapter(reply));
    const result = await agent.generate(makeBlackboard({ topic: 'Should justice override efficiency?' }));

    expect(result.content.length).toBeGreaterThan(0);
    expect(result.content).toContain('value judgment, not an empirical one');
  });
});
