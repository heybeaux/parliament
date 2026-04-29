import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ModelAdapter } from '../../adapters/base.js';
import type { Blackboard } from '../../types.js';
import { ProposerAgent } from '../proposer.js';
import { SkepticAgent } from '../skeptic.js';
import { SynthesizerAgent } from '../synthesizer.js';
import { RedAgent } from '../red-agent.js';
import { SentryAgent } from '../sentry.js';
import { enforceWordCap } from '../utils.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/** Produce a string that is exactly `n` words. */
function nWords(n: number): string {
  return Array.from({ length: n }, (_, i) => `word${i}`).join(' ');
}

// ---------------------------------------------------------------------------
// enforceWordCap utility
// ---------------------------------------------------------------------------

describe('enforceWordCap', () => {
  it('returns content unchanged when under cap', () => {
    const text = 'Hello world';
    const result = enforceWordCap(text, 100);
    expect(result.content).toBe('Hello world');
    expect(result.truncated).toBe(false);
  });

  it('returns content unchanged when exactly at cap', () => {
    const text = nWords(100);
    const result = enforceWordCap(text, 100);
    expect(result.truncated).toBe(false);
  });

  it('truncates when over cap', () => {
    const text = nWords(150);
    const result = enforceWordCap(text, 100);
    expect(result.truncated).toBe(true);
    expect(result.content.split(/\s+/).length).toBe(100);
  });

  it('trims leading/trailing whitespace before counting', () => {
    const text = '  hello world  ';
    const result = enforceWordCap(text, 100);
    expect(result.content).toBe('hello world');
    expect(result.truncated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ProposerAgent
// ---------------------------------------------------------------------------

describe('ProposerAgent', () => {
  let adapter: ModelAdapter;

  beforeEach(() => {
    adapter = makeAdapter('AI regulation is important for safety and accountability.');
  });

  it('has correct role and neurotype', () => {
    const agent = new ProposerAgent(adapter);
    expect(agent.role).toBe('Proposer');
    expect(agent.neurotype).toBe('structured');
  });

  it('happy path: returns AgentResult with content and truncated=false', async () => {
    const agent = new ProposerAgent(adapter);
    const board = makeBlackboard();
    const result = await agent.generate(board);

    expect(result.content).toBe('AI regulation is important for safety and accountability.');
    expect(result.truncated).toBe(false);
    expect(adapter.generate).toHaveBeenCalledOnce();
  });

  it('passes the system prompt to the adapter', async () => {
    const agent = new ProposerAgent(adapter);
    const board = makeBlackboard();
    await agent.generate(board);

    const [, systemArg] = (adapter.generate as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(systemArg).toMatch(/structured reasoner/i);
  });

  it('includes recent turns in the user prompt', async () => {
    const agent = new ProposerAgent(adapter);
    const board = makeBlackboard({
      turns: [{ agent: 'Skeptic', neurotype: 'critical', model: 'test', content: 'I doubt this.', timestamp: '' }],
    });
    await agent.generate(board);

    const [userPrompt] = (adapter.generate as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(userPrompt).toContain('I doubt this.');
  });

  it('enforces 100-word cap: truncated=true when response > 100 words', async () => {
    const longResponse = nWords(150);
    const agent = new ProposerAgent(makeAdapter(longResponse));
    const board = makeBlackboard();
    const result = await agent.generate(board);

    expect(result.truncated).toBe(true);
    expect(result.content.split(/\s+/).length).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// SkepticAgent
// ---------------------------------------------------------------------------

describe('SkepticAgent', () => {
  let adapter: ModelAdapter;

  beforeEach(() => {
    adapter = makeAdapter('However, this assumes regulators have sufficient expertise, which is unproven.');
  });

  it('has correct role and neurotype', () => {
    const agent = new SkepticAgent(adapter);
    expect(agent.role).toBe('Skeptic');
    expect(agent.neurotype).toBe('critical');
  });

  it('happy path: returns AgentResult', async () => {
    const agent = new SkepticAgent(adapter);
    const board = makeBlackboard({
      turns: [{ agent: 'Proposer', neurotype: 'structured', model: 'test', content: 'Regulation is good.', timestamp: '' }],
    });
    const result = await agent.generate(board);

    expect(result.content).toBeTruthy();
    expect(typeof result.truncated).toBe('boolean');
  });

  it('appends a Conflict to blackboard.conflicts', async () => {
    const agent = new SkepticAgent(adapter);
    const board = makeBlackboard({
      turns: [{ agent: 'Proposer', neurotype: 'structured', model: 'test', content: 'Regulation is good.', timestamp: '' }],
    });

    expect(board.conflicts).toHaveLength(0);
    await agent.generate(board);
    expect(board.conflicts).toHaveLength(1);
  });

  it('conflict.between includes Skeptic and the last turn agent', async () => {
    const agent = new SkepticAgent(adapter);
    const board = makeBlackboard({
      turns: [{ agent: 'Proposer', neurotype: 'structured', model: 'test', content: 'Regulation is good.', timestamp: '' }],
    });
    await agent.generate(board);

    const conflict = board.conflicts[0]!;
    expect(conflict.between).toContain('Skeptic');
    expect(conflict.between).toContain('Proposer');
    expect(conflict.resolved).toBe(false);
  });

  it('conflict.description is at most 100 chars', async () => {
    const agent = new SkepticAgent(adapter);
    const board = makeBlackboard({
      turns: [{ agent: 'Proposer', neurotype: 'structured', model: 'test', content: 'Regulation is good.', timestamp: '' }],
    });
    await agent.generate(board);

    expect(board.conflicts[0]!.description.length).toBeLessThanOrEqual(100);
  });

  it('uses "Unknown" as last agent when there are no turns', async () => {
    const agent = new SkepticAgent(adapter);
    const board = makeBlackboard();
    await agent.generate(board);

    expect(board.conflicts[0]!.between).toContain('Unknown');
  });

  it('enforces 100-word cap on output', async () => {
    const longResponse = nWords(150);
    const agent = new SkepticAgent(makeAdapter(longResponse));
    const board = makeBlackboard({
      turns: [{ agent: 'Proposer', neurotype: 'structured', model: 'test', content: 'Regulation is good.', timestamp: '' }],
    });
    const result = await agent.generate(board);

    expect(result.truncated).toBe(true);
    expect(result.content.split(/\s+/).length).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// SynthesizerAgent
// ---------------------------------------------------------------------------

describe('SynthesizerAgent', () => {
  it('has correct role and neurotype', () => {
    const agent = new SynthesizerAgent(makeAdapter('Both sides have merit. confidence: 0.7'));
    expect(agent.role).toBe('Synthesizer');
    expect(agent.neurotype).toBe('integrative');
  });

  it('happy path: returns content and confidence', async () => {
    const agent = new SynthesizerAgent(makeAdapter('Both sides have merit. confidence: 0.7'));
    const board = makeBlackboard();
    const result = await agent.generate(board);

    expect(result.content).toBeTruthy();
    expect(typeof result.truncated).toBe('boolean');
    expect(result.confidence).toBeCloseTo(0.7);
  });

  it('defaults confidence to 0.5 when not present in response', async () => {
    const agent = new SynthesizerAgent(makeAdapter('A balanced view without any confidence marker.'));
    const board = makeBlackboard();
    const result = await agent.generate(board);

    expect(result.confidence).toBe(0.5);
  });

  it('parses confidence: 0.X pattern', async () => {
    const agent = new SynthesizerAgent(makeAdapter('My synthesis. confidence: 0.85'));
    const board = makeBlackboard();
    const result = await agent.generate(board);

    expect(result.confidence).toBeCloseTo(0.85);
  });

  it('parses confidence: 1.0 correctly', async () => {
    const agent = new SynthesizerAgent(makeAdapter('High certainty. confidence: 1.0'));
    const board = makeBlackboard();
    const result = await agent.generate(board);

    expect(result.confidence).toBeCloseTo(1.0);
  });

  it('enforces 100-word cap on output', async () => {
    const longResponse = nWords(150) + ' confidence: 0.6';
    const agent = new SynthesizerAgent(makeAdapter(longResponse));
    const board = makeBlackboard();
    const result = await agent.generate(board);

    expect(result.truncated).toBe(true);
    expect(result.content.split(/\s+/).length).toBe(100);
  });

  it('includes unresolved conflicts in user prompt', async () => {
    const adapter = makeAdapter('Synthesis. confidence: 0.5');
    const agent = new SynthesizerAgent(adapter);
    const board = makeBlackboard({
      conflicts: [{ between: ['Skeptic', 'Proposer'], description: 'Core disagreement', resolved: false }],
    });
    await agent.generate(board);

    const [userPrompt] = (adapter.generate as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(userPrompt).toContain('Core disagreement');
  });
});

// ---------------------------------------------------------------------------
// RedAgent
// ---------------------------------------------------------------------------

describe('RedAgent', () => {
  it('has correct role and neurotype', () => {
    const agent = new RedAgent(makeAdapter('What if regulation itself is the problem?'));
    expect(agent.role).toBe('RedAgent');
    expect(agent.neurotype).toBe('disruptive');
  });

  it('happy path: returns AgentResult', async () => {
    const agent = new RedAgent(makeAdapter('What if regulation itself is the problem?'));
    const board = makeBlackboard();
    const result = await agent.generate(board);

    expect(result.content).toBeTruthy();
    expect(typeof result.truncated).toBe('boolean');
  });

  it('passes the system prompt to the adapter', async () => {
    const adapter = makeAdapter('Challenge accepted.');
    const agent = new RedAgent(adapter);
    const board = makeBlackboard();
    await agent.generate(board);

    const [, systemArg] = (adapter.generate as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(systemArg).toMatch(/disruptor/i);
  });

  it('does not modify blackboard conflicts', async () => {
    const agent = new RedAgent(makeAdapter('Challenge accepted.'));
    const board = makeBlackboard();
    await agent.generate(board);

    expect(board.conflicts).toHaveLength(0);
  });

  it('enforces 100-word cap on output', async () => {
    const longResponse = nWords(120);
    const agent = new RedAgent(makeAdapter(longResponse));
    const board = makeBlackboard();
    const result = await agent.generate(board);

    expect(result.truncated).toBe(true);
    expect(result.content.split(/\s+/).length).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// SentryAgent
// ---------------------------------------------------------------------------

describe('SentryAgent', () => {
  it('has correct role and neurotype', () => {
    const agent = new SentryAgent(makeAdapter('OK'));
    expect(agent.role).toBe('Sentry');
    expect(agent.neurotype).toBe('monitoring');
  });

  it('returns ok when model says OK', async () => {
    const agent = new SentryAgent(makeAdapter('OK'));
    const board = makeBlackboard();
    const result = await agent.generate(board);

    expect(result.signal).toBe('ok');
  });

  it('returns specialist_needed when model says SPECIALIST_NEEDED', async () => {
    const agent = new SentryAgent(makeAdapter('SPECIALIST_NEEDED'));
    const board = makeBlackboard();
    const result = await agent.generate(board);

    expect(result.signal).toBe('specialist_needed');
  });

  it('returns collapse_detected when model says COLLAPSE_DETECTED', async () => {
    // Need turns that don't trigger programmatic check so model is reached.
    const agent = new SentryAgent(makeAdapter('COLLAPSE_DETECTED'));
    const board = makeBlackboard({
      turns: [
        { agent: 'Proposer', neurotype: 'structured', model: 'test', content: 'Regulation is good.', timestamp: '' },
        { agent: 'Skeptic', neurotype: 'critical', model: 'test', content: 'Regulation is bad.', timestamp: '' },
      ],
    });
    const result = await agent.generate(board);

    expect(result.signal).toBe('collapse_detected');
  });

  it('programmatically detects collapse when last 2 turns are same role with high similarity', async () => {
    const collapseAdapter = makeAdapter('OK');
    const agent = new SentryAgent(collapseAdapter);
    const repeatedContent = 'Regulation is absolutely essential for safety and accountability in AI systems.';
    const board = makeBlackboard({
      turns: [
        { agent: 'Proposer', neurotype: 'structured', model: 'test', content: repeatedContent, timestamp: '' },
        { agent: 'Proposer', neurotype: 'structured', model: 'test', content: repeatedContent, timestamp: '' },
      ],
    });
    const result = await agent.generate(board);

    expect(result.signal).toBe('collapse_detected');
    // Model should NOT have been called since the check short-circuits.
    expect(collapseAdapter.generate).not.toHaveBeenCalled();
  });

  it('does not trigger programmatic collapse when last 2 turns are different roles', async () => {
    const adapter = makeAdapter('OK');
    const agent = new SentryAgent(adapter);
    const board = makeBlackboard({
      turns: [
        { agent: 'Proposer', neurotype: 'structured', model: 'test', content: 'Same content here exactly.', timestamp: '' },
        { agent: 'Skeptic', neurotype: 'critical', model: 'test', content: 'Same content here exactly.', timestamp: '' },
      ],
    });
    const result = await agent.generate(board);

    // Different agents — no programmatic collapse, model is consulted.
    expect(adapter.generate).toHaveBeenCalledOnce();
    expect(result.signal).toBe('ok');
  });

  it('does not trigger programmatic collapse when same role but low similarity', async () => {
    const adapter = makeAdapter('OK');
    const agent = new SentryAgent(adapter);
    const board = makeBlackboard({
      turns: [
        { agent: 'Proposer', neurotype: 'structured', model: 'test', content: 'Completely different first statement about regulation.', timestamp: '' },
        { agent: 'Proposer', neurotype: 'structured', model: 'test', content: 'Totally unrelated second point concerning freedom and markets.', timestamp: '' },
      ],
    });
    await agent.generate(board);

    // Low similarity — model should be consulted.
    expect(adapter.generate).toHaveBeenCalledOnce();
  });

  it('falls back to ok signal for unrecognised model output', async () => {
    const agent = new SentryAgent(makeAdapter('Everything looks fine.'));
    const board = makeBlackboard();
    const result = await agent.generate(board);

    expect(result.signal).toBe('ok');
  });
});

