import { describe, it, expect, vi } from 'vitest';
import type { ModelAdapter } from '../../adapters/base.js';
import type { Blackboard } from '../../types.js';
import { TranslatorAgent, TRANSLATOR_SYSTEM_PROMPT } from '../translator.js';
import { BUILTIN_AGENT_REGISTRY, createBuiltinAgent } from '../registry.js';

function makeAdapter(response: string): ModelAdapter {
  return { modelName: 'test-model', generate: vi.fn().mockResolvedValue({ content: response }) };
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

describe('TranslatorAgent', () => {
  it('has role Translator and neurotype translator', () => {
    const agent = new TranslatorAgent(makeAdapter('ok'));
    expect(agent.role).toBe('Translator');
    expect(agent.neurotype).toBe('translator');
  });

  it('is registered under the kebab-case id "translator"', () => {
    expect(BUILTIN_AGENT_REGISTRY).toHaveProperty('translator');
    const agent = createBuiltinAgent('translator', makeAdapter('ok'));
    expect(agent.neurotype).toBe('translator');
  });

  it('passes the assumption-first system prompt to the adapter', async () => {
    const adapter = makeAdapter('ok');
    const agent = new TranslatorAgent(adapter);
    await agent.generate(makeBlackboard());

    const [, systemArg] = (adapter.generate as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(systemArg).toBe(TRANSLATOR_SYSTEM_PROMPT);
    // Priority order is encoded in the prompt.
    expect(systemArg).toMatch(/load-bearing assumption/i);
    expect(systemArg).toMatch(/in plain language/i);
    expect(systemArg).toMatch(/assumption-surfacing comes FIRST/i);
    // The trade-off rule is encoded explicitly.
    expect(systemArg).toMatch(/drop the restatement and keep the assumptions/i);
  });

  it('embeds the topic and recent turns in the user prompt', async () => {
    const adapter = makeAdapter('the load-bearing assumption is regulators understand the systems they would govern.');
    const agent = new TranslatorAgent(adapter);
    const board = makeBlackboard({
      turns: [
        { agent: 'Proposer', neurotype: 'structured', model: 'test', content: 'AI systems should be regulated.', timestamp: '', round: 1 },
      ],
    });
    await agent.generate(board);

    const [userPrompt] = (adapter.generate as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(userPrompt).toContain('Should AI systems be regulated?');
    expect(userPrompt).toContain('AI systems should be regulated.');
  });

  it('returns adapter response as content with truncated=false when under cap', async () => {
    const reply = 'the load-bearing assumption is that current regulators have technical literacy.';
    const agent = new TranslatorAgent(makeAdapter(reply));
    const result = await agent.generate(makeBlackboard());

    expect(result.content).toBe(reply);
    expect(result.truncated).toBe(false);
  });

  it('enforces the 200-word cap and sets truncated=true', async () => {
    const longResponse = nWords(250);
    const agent = new TranslatorAgent(makeAdapter(longResponse));
    const result = await agent.generate(makeBlackboard());

    expect(result.truncated).toBe(true);
    expect(result.content.split(/\s+/).length).toBe(200);
  });

  it('prioritizes assumption-surfacing over compression when assumptions are present', async () => {
    // Per the elaboration decision, assumption-surfacing must precede the
    // plain-language restatement when both appear in the same turn.
    const reply =
      'the load-bearing assumption is that regulators have the technical literacy to write effective rules. ' +
      'In plain language: the room is debating whether to write AI rules now, but everyone is presuming the rule-writers know enough about AI to write rules that bind it.';
    const agent = new TranslatorAgent(makeAdapter(reply));
    const board = makeBlackboard({
      turns: [
        { agent: 'Proposer', neurotype: 'structured', model: 'test', content: 'AI systems should be regulated.', timestamp: '', round: 1 },
      ],
    });
    const result = await agent.generate(board);

    const lower = result.content.toLowerCase();
    expect(lower).toContain('the load-bearing assumption is');
    expect(lower).toContain('in plain language');
    // Order matters: assumption-surfacing must come first.
    const assumptionIdx = lower.indexOf('the load-bearing assumption is');
    const plainIdx = lower.indexOf('in plain language');
    expect(assumptionIdx).toBeGreaterThanOrEqual(0);
    expect(plainIdx).toBeGreaterThan(assumptionIdx);
  });

  it('falls back to a clean compression when no implicit assumptions are present', async () => {
    // For a neutral procedural turn, the system prompt explicitly instructs
    // the agent to skip the assumption section and open with "in plain language".
    const reply =
      'in plain language: the room agreed to break for fifteen minutes and resume with the Pragmatist. ' +
      'No substantive claims were made; nothing to translate or unpack.';
    const agent = new TranslatorAgent(makeAdapter(reply));
    const board = makeBlackboard({
      turns: [
        { agent: 'Proposer', neurotype: 'structured', model: 'test', content: 'Let\'s break for fifteen minutes.', timestamp: '', round: 1 },
      ],
    });
    const result = await agent.generate(board);

    expect(result.content.toLowerCase()).toMatch(/^in plain language/);
  });

  it('preserves the literal "load-bearing assumption" anchor when the model emits it', async () => {
    const reply = 'the load-bearing assumption is that all parties agree on what counts as harm.';
    const agent = new TranslatorAgent(makeAdapter(reply));
    const result = await agent.generate(makeBlackboard());

    expect(result.content.toLowerCase()).toContain('the load-bearing assumption is');
  });
});
