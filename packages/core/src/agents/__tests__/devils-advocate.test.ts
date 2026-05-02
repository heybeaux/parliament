import { describe, it, expect, vi } from 'vitest';
import type { ModelAdapter } from '../../adapters/base.js';
import type { Blackboard } from '../../types.js';
import {
  DevilsAdvocateAgent,
  DEVILS_ADVOCATE_ROUND1_SYSTEM_PROMPT,
  DEVILS_ADVOCATE_ROUND2_SYSTEM_PROMPT,
  isRoundOne,
} from '../devils-advocate.js';
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

describe('DevilsAdvocateAgent', () => {
  it('has role DevilsAdvocate and neurotype devils-advocate', () => {
    const agent = new DevilsAdvocateAgent(makeAdapter('ok'));
    expect(agent.role).toBe('DevilsAdvocate');
    expect(agent.neurotype).toBe('devils-advocate');
  });

  it('is registered under the kebab-case id "devils-advocate"', () => {
    expect(BUILTIN_AGENT_REGISTRY).toHaveProperty('devils-advocate');
    const agent = createBuiltinAgent('devils-advocate', makeAdapter('ok'));
    expect(agent.neurotype).toBe('devils-advocate');
  });

  it('round 1: passes the round-1 system prompt that targets the unstated assumption', async () => {
    const adapter = makeAdapter('the unstated assumption is regulators understand the systems they would govern.');
    const agent = new DevilsAdvocateAgent(adapter);
    // Round 1: only the Proposer has spoken once.
    const board = makeBlackboard({
      turns: [
        { agent: 'Proposer', neurotype: 'structured', model: 'test', content: 'AI systems should be regulated.', timestamp: '', round: 1 },
      ],
    });
    await agent.generate(board);

    const [, systemArg] = (adapter.generate as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(systemArg).toBe(DEVILS_ADVOCATE_ROUND1_SYSTEM_PROMPT);
    expect(systemArg).toMatch(/unstated assumption/i);
    expect(systemArg).toMatch(/Round 1/);
    // Few-shot example must be present.
    expect(systemArg).toMatch(/Few-shot example/);
    expect(systemArg).toMatch(/Proposer claim:/);
  });

  it('round 1: output references an implicit assumption rather than the stated thesis directly', async () => {
    // Adapter response simulates a model that followed the round-1 instruction.
    const reply =
      'the unstated assumption is that regulators have the technical literacy to write rules that actually bind frontier systems; ' +
      'strip that and the proposal collapses into compliance theatre.';
    const agent = new DevilsAdvocateAgent(makeAdapter(reply));
    const board = makeBlackboard({
      turns: [
        { agent: 'Proposer', neurotype: 'structured', model: 'test', content: 'AI systems should be regulated.', timestamp: '', round: 1 },
      ],
    });
    const result = await agent.generate(board);

    expect(result.content.toLowerCase()).toContain('the unstated assumption is');
    // The output targets the implicit assumption, not the stated thesis verbatim.
    expect(result.content).not.toMatch(/^AI systems should not be regulated\.?$/i);
  });

  it('round >= 2: passes the round-2+ system prompt that targets the dominant view', async () => {
    const adapter = makeAdapter('the dominant view in this round is that critique has overwhelmed the proposal.');
    const agent = new DevilsAdvocateAgent(adapter);
    // Round 2+: turns explicitly stamped round=2.
    const board = makeBlackboard({
      turns: [
        { agent: 'Proposer', neurotype: 'structured', model: 'test', content: 'AI systems should be regulated.', timestamp: '', round: 1 },
        { agent: 'Skeptic', neurotype: 'critical', model: 'test', content: 'But regulators lack expertise.', timestamp: '', round: 1 },
        { agent: 'Skeptic', neurotype: 'critical', model: 'test', content: 'And capture is rampant.', timestamp: '', round: 2 },
        { agent: 'Skeptic', neurotype: 'critical', model: 'test', content: 'The proposal is not workable.', timestamp: '', round: 2 },
      ],
    });
    await agent.generate(board);

    const [, systemArg] = (adapter.generate as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(systemArg).toBe(DEVILS_ADVOCATE_ROUND2_SYSTEM_PROMPT);
    expect(systemArg).toMatch(/dominant view/i);
    expect(systemArg).toMatch(/consensus-tracking, NOT fixed-target/);
  });

  it('round >= 2: inverts target — when critique has dominated recent turns, the prompt instructs defending the original claim', async () => {
    // We do not control what the model emits, but we can verify the SYSTEM prompt
    // explicitly instructs inversion based on what has dominated. The critique-
    // heavy transcript below pushes the model toward defending the claim.
    const adapter = makeAdapter('the dominant view in this round is critique; defending the original claim, the alternative — uncoordinated incident response — has historically been worse.');
    const agent = new DevilsAdvocateAgent(adapter);
    const board = makeBlackboard({
      turns: [
        { agent: 'Proposer', neurotype: 'structured', model: 'test', content: 'AI systems should be regulated.', timestamp: '', round: 1 },
        { agent: 'Skeptic', neurotype: 'critical', model: 'test', content: 'Regulators lack expertise.', timestamp: '', round: 1 },
        { agent: 'Skeptic', neurotype: 'critical', model: 'test', content: 'Capture is rampant.', timestamp: '', round: 2 },
        { agent: 'Skeptic', neurotype: 'critical', model: 'test', content: 'The proposal is unworkable.', timestamp: '', round: 2 },
      ],
    });
    await agent.generate(board);

    const [, systemArg] = (adapter.generate as ReturnType<typeof vi.fn>).mock.calls[0];
    // Prompt encodes the inversion behaviour symmetrically.
    expect(systemArg).toMatch(/If critique has dominated recently, defend the original claim/);
    expect(systemArg).toMatch(/If affirmation has dominated, attack it/);
  });

  it('embeds the topic and recent turns in the user prompt', async () => {
    const adapter = makeAdapter('the unstated assumption is regulators can audit what they regulate.');
    const agent = new DevilsAdvocateAgent(adapter);
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
    const reply = 'the unstated assumption is that regulators understand the technology.';
    const agent = new DevilsAdvocateAgent(makeAdapter(reply));
    const result = await agent.generate(makeBlackboard());

    expect(result.content).toBe(reply);
    expect(result.truncated).toBe(false);
  });

  it('enforces the 200-word cap and sets truncated=true', async () => {
    const longResponse = nWords(250);
    const agent = new DevilsAdvocateAgent(makeAdapter(longResponse));
    const result = await agent.generate(makeBlackboard());

    expect(result.truncated).toBe(true);
    expect(result.content.split(/\s+/).length).toBe(200);
  });
});

describe('isRoundOne helper', () => {
  it('returns true on an empty transcript', () => {
    expect(isRoundOne([])).toBe(true);
  });

  it('returns true with a single round-1 turn', () => {
    expect(isRoundOne([
      { agent: 'Proposer', neurotype: 'structured', model: 'test', content: 'x', timestamp: '', round: 1 },
    ])).toBe(true);
  });

  it('returns false once any turn carries round >= 2', () => {
    expect(isRoundOne([
      { agent: 'Proposer', neurotype: 'structured', model: 'test', content: 'x', timestamp: '', round: 1 },
      { agent: 'Skeptic', neurotype: 'critical', model: 'test', content: 'y', timestamp: '', round: 2 },
    ])).toBe(false);
  });

  it('returns false once the room has formed a view (>2 turns even at round=1)', () => {
    expect(isRoundOne([
      { agent: 'Proposer', neurotype: 'structured', model: 'test', content: 'x', timestamp: '', round: 1 },
      { agent: 'Skeptic', neurotype: 'critical', model: 'test', content: 'y', timestamp: '', round: 1 },
      { agent: 'Pragmatist', neurotype: 'pragmatist', model: 'test', content: 'z', timestamp: '', round: 1 },
    ])).toBe(false);
  });
});
