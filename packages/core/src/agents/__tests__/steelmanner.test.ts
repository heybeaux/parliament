import { describe, it, expect, vi } from 'vitest';
import type { ModelAdapter } from '../../adapters/base.js';
import type { Blackboard } from '../../types.js';
import { SteelmannerAgent, STEELMANNER_SYSTEM_PROMPT } from '../steelmanner.js';
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

describe('SteelmannerAgent', () => {
  it('has role Steelmanner and neurotype steelmanner', () => {
    const agent = new SteelmannerAgent(makeAdapter('ok'));
    expect(agent.role).toBe('Steelmanner');
    expect(agent.neurotype).toBe('steelmanner');
  });

  it('is registered under the kebab-case id "steelmanner"', () => {
    expect(BUILTIN_AGENT_REGISTRY).toHaveProperty('steelmanner');
    const agent = createBuiltinAgent('steelmanner', makeAdapter('ok'));
    expect(agent.neurotype).toBe('steelmanner');
  });

  it('passes the charity-posture system prompt to the adapter', async () => {
    const adapter = makeAdapter('ok');
    const agent = new SteelmannerAgent(adapter);
    await agent.generate(makeBlackboard());

    const [, systemArg] = (adapter.generate as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(systemArg).toBe(STEELMANNER_SYSTEM_PROMPT);
    expect(systemArg).toMatch(/strongest opposing case/i);
    expect(systemArg).toMatch(/good-faith/i);
    // Anti-strawman guardrail.
    expect(systemArg).toMatch(/straw-?man/i);
  });

  it('embeds the topic and recent turns in the user prompt with a steelman framing', async () => {
    const adapter = makeAdapter('the strongest opposing case is that pre-emptive regulation calcifies markets.');
    const agent = new SteelmannerAgent(adapter);
    const board = makeBlackboard({
      turns: [
        { agent: 'Proposer', neurotype: 'structured', model: 'test', content: 'Regulation is necessary.', timestamp: '', round: 1 },
      ],
    });
    await agent.generate(board);

    const [userPrompt] = (adapter.generate as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(userPrompt).toContain('Should AI systems be regulated?');
    expect(userPrompt).toContain('Regulation is necessary.');
    expect(userPrompt).toMatch(/steelman against/i);
  });

  it('returns adapter response as content with truncated=false when under cap', async () => {
    const reply = 'the strongest opposing case is that ex-ante rules calcify nascent markets.';
    const agent = new SteelmannerAgent(makeAdapter(reply));
    const result = await agent.generate(makeBlackboard());

    expect(result.content).toBe(reply);
    expect(result.truncated).toBe(false);
  });

  it('enforces the 200-word cap and sets truncated=true', async () => {
    const longResponse = nWords(250);
    const agent = new SteelmannerAgent(makeAdapter(longResponse));
    const result = await agent.generate(makeBlackboard());

    expect(result.truncated).toBe(true);
    expect(result.content.split(/\s+/).length).toBe(200);
  });

  it('preserves the literal "the strongest opposing case is" opener when the model emits it', async () => {
    const reply =
      'the strongest opposing case is that regulation freezes the field at the pre-AGI status quo, ' +
      'shielding incumbents and starving safety research that needs frontier capability access to proceed.';
    const agent = new SteelmannerAgent(makeAdapter(reply));
    const board = makeBlackboard({
      turns: [
        { agent: 'Proposer', neurotype: 'structured', model: 'test', content: 'Regulation is obviously good.', timestamp: '', round: 1 },
      ],
    });
    const result = await agent.generate(board);

    expect(result.content.toLowerCase()).toContain('the strongest opposing case is');
  });

  it('produces an opposing case in good-faith terms (no strawman markers)', async () => {
    // Good-faith opposing case: presents the alternative position as its own
    // proponents would phrase it. No "they obviously think" / "the silly
    // objection that" framing.
    const reply =
      'the strongest opposing case is that effective AI risk reduction comes from sustained engineering investment ' +
      'rather than statutory rules; in this view, premature regulation hardens current architectures into law and ' +
      'crowds out the iteration that actually closes safety gaps.';
    const agent = new SteelmannerAgent(makeAdapter(reply));
    const result = await agent.generate(makeBlackboard());

    expect(result.content).toMatch(/the strongest opposing case is/i);
    // Hard guardrail: no strawman tells.
    expect(result.content).not.toMatch(/\b(they obviously think|silly objection|stupid argument|absurd claim)\b/i);
  });
});
