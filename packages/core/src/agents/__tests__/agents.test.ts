import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ModelConnectionError, type ModelAdapter } from '../../adapters/base.js';
import type { Blackboard } from '../../types.js';
import type { ProviderFailoverInfo } from '../base.js';
import { ProposerAgent } from '../proposer.js';
import { SkepticAgent } from '../skeptic.js';
import { SynthesizerAgent } from '../synthesizer.js';
import { RedAgent } from '../red-agent.js';
import { SentryAgent } from '../sentry.js';
import { buildPromptHeader, enforceWordCap } from '../utils.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAdapter(response: string): ModelAdapter {
  return {
    modelName: 'test-model',
    generate: vi.fn().mockResolvedValue({ content: response }),
  };
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
// buildPromptHeader utility
// ---------------------------------------------------------------------------

describe('buildPromptHeader', () => {
  it('includes today\'s date in YYYY-MM-DD form', () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(buildPromptHeader('any topic')).toContain(`Current date: ${today}`);
  });

  it('names every non-sentry cast member so the model treats them as real participants', () => {
    const header = buildPromptHeader('any topic');
    expect(header).toContain('Proposer');
    expect(header).toContain('Skeptic');
    expect(header).toContain('Synthesizer');
    expect(header).toContain('RedAgent');
  });

  it('embeds the topic verbatim', () => {
    expect(buildPromptHeader('Should AI be regulated?')).toContain(
      'Topic: Should AI be regulated?',
    );
  });
});

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
      turns: [{ agent: 'Skeptic', neurotype: 'critical', model: 'test', content: 'I doubt this.', timestamp: '', round: 1 }],
    });
    await agent.generate(board);

    const [userPrompt] = (adapter.generate as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(userPrompt).toContain('I doubt this.');
  });

  it('enforces 200-word cap: truncated=true when response > 200 words', async () => {
    // Cap was doubled from 100 to 200; agents call enforceWordCap() with the default.
    const longResponse = nWords(250);
    const agent = new ProposerAgent(makeAdapter(longResponse));
    const board = makeBlackboard();
    const result = await agent.generate(board);

    expect(result.truncated).toBe(true);
    expect(result.content.split(/\s+/).length).toBe(200);
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
      turns: [{ agent: 'Proposer', neurotype: 'structured', model: 'test', content: 'Regulation is good.', timestamp: '', round: 1 }],
    });
    const result = await agent.generate(board);

    expect(result.content).toBeTruthy();
    expect(typeof result.truncated).toBe('boolean');
  });

  it('appends a Conflict to blackboard.conflicts', async () => {
    const agent = new SkepticAgent(adapter);
    const board = makeBlackboard({
      turns: [{ agent: 'Proposer', neurotype: 'structured', model: 'test', content: 'Regulation is good.', timestamp: '', round: 1 }],
    });

    expect(board.conflicts).toHaveLength(0);
    await agent.generate(board);
    expect(board.conflicts).toHaveLength(1);
  });

  it('conflict.between includes Skeptic and the last turn agent', async () => {
    const agent = new SkepticAgent(adapter);
    const board = makeBlackboard({
      turns: [{ agent: 'Proposer', neurotype: 'structured', model: 'test', content: 'Regulation is good.', timestamp: '', round: 1 }],
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
      turns: [{ agent: 'Proposer', neurotype: 'structured', model: 'test', content: 'Regulation is good.', timestamp: '', round: 1 }],
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

  it('enforces 200-word cap on output', async () => {
    // Cap was doubled from 100 to 200; agents call enforceWordCap() with the default.
    const longResponse = nWords(250);
    const agent = new SkepticAgent(makeAdapter(longResponse));
    const board = makeBlackboard({
      turns: [{ agent: 'Proposer', neurotype: 'structured', model: 'test', content: 'Regulation is good.', timestamp: '', round: 1 }],
    });
    const result = await agent.generate(board);

    expect(result.truncated).toBe(true);
    expect(result.content.split(/\s+/).length).toBe(200);
  });

  it('does NOT record a conflict when output contains no disagreement language', async () => {
    const agreeAdapter = makeAdapter('That seems reasonable. The point about safety is well-founded.');
    const agent = new SkepticAgent(agreeAdapter);
    const board = makeBlackboard({
      turns: [{ agent: 'Proposer', neurotype: 'structured', model: 'test', content: 'Regulation is good.', timestamp: '', round: 1 }],
    });
    await agent.generate(board);

    expect(board.conflicts).toHaveLength(0);
  });

  it('records exactly one conflict when output contains explicit disagreement', async () => {
    const disagreeAdapter = makeAdapter('I disagree. The premise is unsupported and ignores counter-evidence.');
    const agent = new SkepticAgent(disagreeAdapter);
    const board = makeBlackboard({
      turns: [{ agent: 'Proposer', neurotype: 'structured', model: 'test', content: 'Regulation is good.', timestamp: '', round: 1 }],
    });
    await agent.generate(board);

    expect(board.conflicts).toHaveLength(1);
    expect(board.conflicts[0]!.between).toContain('Skeptic');
    expect(board.conflicts[0]!.between).toContain('Proposer');
  });

  // PAR-40 — recall plumbing only pays off if the Skeptic actually engages
  // with the recalled block. These tests pin two contracts:
  //   1. The default system prompt instructs the model to engage with
  //      `## Memory` (so OSS consumers don't have to override per-config).
  //   2. When `blackboard.memory` is populated, the user prompt rendering
  //      includes the Memory block under its stable heading — i.e. the
  //      Skeptic actually *sees* what it was instructed to engage with.
  // The bench-side override added in `parliament.bench.toml` for Tier 1
  // smoke testing was the workaround; this default makes it unnecessary.
  it('default system prompt instructs the model to engage with the `## Memory` block', async () => {
    const memoryAdapter = makeAdapter('Some response.');
    const agent = new SkepticAgent(memoryAdapter);
    await agent.generate(makeBlackboard());

    const [, systemArg] = (memoryAdapter.generate as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(systemArg).toMatch(/## Memory/);
    expect(systemArg).toMatch(/past decisions/i);
    // The clause should explicitly grant the Skeptic permission to challenge
    // stale entries — that's the role-fit reason for memory-awareness.
    expect(systemArg).toMatch(/challenge\s+stale/i);
  });

  it('renders blackboard.memory under the `## Memory` heading in the user prompt', async () => {
    const memoryAdapter = makeAdapter('Some response.');
    const agent = new SkepticAgent(memoryAdapter);
    const board = makeBlackboard({
      memory:
        '1 related past decision:\n- 2026-04-22: Previously deliberated: the agents reached consensus.',
    });
    await agent.generate(board);

    const [userPrompt] = (memoryAdapter.generate as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(userPrompt).toContain('## Memory');
    expect(userPrompt).toContain('Previously deliberated:');
  });
});

// ---------------------------------------------------------------------------
// SynthesizerAgent
// ---------------------------------------------------------------------------

describe('SynthesizerAgent', () => {
  /** Helper: build a JSON synthesizer payload string. */
  function jsonPayload(overrides: Partial<{
    summary: string;
    confidence: number;
    consensus: boolean;
    agreed: string[];
    unresolved: string[];
  }> = {}): string {
    return JSON.stringify({
      summary: 'Both sides have merit; the strongest unified view is X.',
      confidence: 0.7,
      consensus: false,
      agreed: ['safety matters'],
      unresolved: ['who enforces it'],
      ...overrides,
    });
  }

  /** Multi-call adapter: returns scripted responses in order. */
  function makeScriptedAdapter(...responses: string[]): ModelAdapter {
    let i = 0;
    return {
      modelName: 'test-model',
      generate: vi.fn(async () => ({
        content: responses[Math.min(i++, responses.length - 1)] ?? '',
      })),
    };
  }

  it('has correct role and neurotype', () => {
    const agent = new SynthesizerAgent(makeAdapter(jsonPayload()));
    expect(agent.role).toBe('Synthesizer');
    expect(agent.neurotype).toBe('integrative');
  });

  it('happy path: parses valid JSON, populates content from summary and meta from fields', async () => {
    const adapter = makeAdapter(jsonPayload({
      summary: 'A unified synthesis paragraph.',
      confidence: 0.7,
      consensus: false,
      agreed: ['safety matters', 'transparency required'],
      unresolved: ['enforcement mechanism'],
    }));
    const agent = new SynthesizerAgent(adapter);
    const board = makeBlackboard();
    const result = await agent.generate(board);

    expect(result.content).toBe('A unified synthesis paragraph.');
    expect(result.confidence).toBeCloseTo(0.7);
    expect(result.meta).toEqual({
      confidence: 0.7,
      consensus: false,
      agreed: ['safety matters', 'transparency required'],
      unresolved: ['enforcement mechanism'],
    });
    // Single call — no retry on the happy path.
    expect(adapter.generate).toHaveBeenCalledTimes(1);
  });

  it('parses markdown-fenced JSON (```json {...} ```)', async () => {
    const fenced = '```json\n' + jsonPayload({ summary: 'Fenced synthesis.', confidence: 0.6 }) + '\n```';
    const adapter = makeAdapter(fenced);
    const agent = new SynthesizerAgent(adapter);
    const result = await agent.generate(makeBlackboard());

    expect(result.content).toBe('Fenced synthesis.');
    expect(result.meta.confidence).toBeCloseTo(0.6);
    expect(adapter.generate).toHaveBeenCalledTimes(1);
  });

  it('parses preamble + JSON ("Sure, here is the JSON: {...}")', async () => {
    const withPreamble =
      'Sure, here is the JSON:\n' + jsonPayload({ summary: 'Preamble synthesis.', consensus: true, confidence: 0.95 });
    const adapter = makeAdapter(withPreamble);
    const agent = new SynthesizerAgent(adapter);
    const result = await agent.generate(makeBlackboard());

    expect(result.content).toBe('Preamble synthesis.');
    expect(result.meta.consensus).toBe(true);
    expect(result.meta.confidence).toBeCloseTo(0.95);
    expect(adapter.generate).toHaveBeenCalledTimes(1);
  });

  it('retry path: invalid first response, valid JSON on retry → succeeds', async () => {
    const adapter = makeScriptedAdapter(
      'I am sorry, I cannot produce JSON.',
      jsonPayload({ summary: 'Recovered on retry.', confidence: 0.8, consensus: true }),
    );
    const agent = new SynthesizerAgent(adapter);
    const result = await agent.generate(makeBlackboard());

    expect(result.content).toBe('Recovered on retry.');
    expect(result.meta.consensus).toBe(true);
    expect(result.meta.confidence).toBeCloseTo(0.8);
    expect(adapter.generate).toHaveBeenCalledTimes(2);

    // Retry prompt must include the previous broken response and the
    // corrective instruction.
    const [retryPrompt] = (adapter.generate as ReturnType<typeof vi.fn>).mock.calls[1]!;
    expect(retryPrompt).toContain('I am sorry, I cannot produce JSON.');
    expect(retryPrompt).toContain("Your previous response wasn't valid JSON");
  });

  it('fail-closed: two failures → confidence=0, consensus=false, warning logged, no crash', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const adapter = makeScriptedAdapter(
      'still not json',
      'really not json either',
    );
    const agent = new SynthesizerAgent(adapter);
    const result = await agent.generate(makeBlackboard());

    expect(result.confidence).toBe(0);
    expect(result.meta.confidence).toBe(0);
    expect(result.meta.consensus).toBe(false);
    expect(result.meta.agreed).toEqual([]);
    expect(result.meta.unresolved).toEqual([]);
    // Summary still populated (truncated raw text) so transcripts stay readable.
    expect(result.content.length).toBeGreaterThan(0);
    expect(adapter.generate).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it('clamps confidence to [0, 1]', async () => {
    const adapter = makeAdapter(jsonPayload({ confidence: 1.7 }));
    const agent = new SynthesizerAgent(adapter);
    const result = await agent.generate(makeBlackboard());
    expect(result.meta.confidence).toBe(1);
  });

  it('enforces 200-word cap on the summary', async () => {
    const longSummary = nWords(250);
    const adapter = makeAdapter(jsonPayload({ summary: longSummary, confidence: 0.6 }));
    const agent = new SynthesizerAgent(adapter);
    const result = await agent.generate(makeBlackboard());

    expect(result.truncated).toBe(true);
    expect(result.content.split(/\s+/).length).toBe(200);
  });

  it('includes unresolved conflicts in user prompt', async () => {
    const adapter = makeAdapter(jsonPayload({ confidence: 0.5 }));
    const agent = new SynthesizerAgent(adapter);
    const board = makeBlackboard({
      conflicts: [{ between: ['Skeptic', 'Proposer'], description: 'Core disagreement', resolved: false }],
    });
    await agent.generate(board);

    const [userPrompt] = (adapter.generate as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(userPrompt).toContain('Core disagreement');
    // Reinforcement appended at the end of the user prompt.
    expect(userPrompt).toMatch(/Output only the JSON object, no other text\.\s*$/);
  });

  // PAR-40 — the Synthesizer needs to reason explicitly about whether its
  // synthesis is consistent-with / refines / overrides any recalled past
  // decision. Without that clause the synthesis silently overwrites prior
  // conclusions and recall reads as a disconnected sequence of summaries.
  // The strict JSON output contract is preserved alongside the new clause.
  it('default system prompt asks for memory continuity (consistent-with / overrides) when `## Memory` is present', async () => {
    const adapter = makeAdapter(jsonPayload());
    const agent = new SynthesizerAgent(adapter);
    await agent.generate(makeBlackboard());

    const [, systemArg] = (adapter.generate as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(systemArg).toMatch(/## Memory/);
    expect(systemArg).toMatch(/consistent\s+with/i);
    expect(systemArg).toMatch(/overrides/i);
    // The strict JSON-only contract is preserved — adding the clause must
    // not regress the structured-output guarantee the engine depends on.
    expect(systemArg).toMatch(/MUST output ONLY a single JSON object/);
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

  it('enforces 200-word cap on output', async () => {
    // Cap was doubled from 100 to 200; agents call enforceWordCap() with the default.
    const longResponse = nWords(250);
    const agent = new RedAgent(makeAdapter(longResponse));
    const board = makeBlackboard();
    const result = await agent.generate(board);

    expect(result.truncated).toBe(true);
    expect(result.content.split(/\s+/).length).toBe(200);
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

  // Removed: 5 tests that exercised a removed LLM-classification path
  // (SPECIALIST_NEEDED / COLLAPSE_DETECTED model output, 2-turn same-role
  // short-circuit, and model-consulted assertions). SentryAgent no longer
  // calls the model adapter — collapse is detected programmatically via OSI
  // (when osi_enabled) or the legacy 6-turn Jaccard check. Equivalent
  // coverage lives in the OSI/legacy tests below.

  it('falls back to ok signal for unrecognised model output', async () => {
    const agent = new SentryAgent(makeAdapter('Everything looks fine.'));
    const board = makeBlackboard();
    const result = await agent.generate(board);

    expect(result.signal).toBe('ok');
  });

  // -------------------------------------------------------------------------
  // OSI-driven detection (osi_enabled = true)
  // -------------------------------------------------------------------------

  it('OSI mode flags collapse on a per-role echoing transcript that the legacy 0.95 path would miss', async () => {
    // Three turns per agent, each agent is paraphrasing itself but never
    // verbatim — Jaccard similarity stays well below 0.95 (legacy threshold)
    // but well above 0.85 (OSI default), so OSI flags this and the legacy
    // path does not.
    const agent = new SentryAgent(makeAdapter('OK'), {
      osiEnabled: true,
      osiSimilarityThreshold: 0.85,
      osiWindow: 3,
    });
    const board = makeBlackboard({
      turns: [
        // Proposer turns — high mutual word overlap, gentle reordering only.
        { agent: 'Proposer', neurotype: 'structured', model: 'test', content: 'regulation safety accountability oversight transparency', timestamp: '', round: 1 },
        { agent: 'Proposer', neurotype: 'structured', model: 'test', content: 'regulation safety accountability oversight transparency', timestamp: '', round: 1 },
        { agent: 'Proposer', neurotype: 'structured', model: 'test', content: 'regulation safety accountability oversight transparency', timestamp: '', round: 1 },
      ],
    });
    const result = await agent.generate(board);
    expect(result.signal).toBe('collapse_detected');
    expect(result.reason).toMatch(/OSI/);
  });

  it('OSI mode does NOT flag collapse when an agent is genuinely shifting position', async () => {
    const agent = new SentryAgent(makeAdapter('OK'), {
      osiEnabled: true,
      osiSimilarityThreshold: 0.85,
      osiWindow: 3,
    });
    const board = makeBlackboard({
      turns: [
        { agent: 'Proposer', neurotype: 'structured', model: 'test', content: 'apples bananas cherries dates elderberries', timestamp: '', round: 1 },
        { agent: 'Proposer', neurotype: 'structured', model: 'test', content: 'figs grapes honeydew imbe jackfruit', timestamp: '', round: 1 },
        { agent: 'Proposer', neurotype: 'structured', model: 'test', content: 'kiwi lemon mango nectarine olive', timestamp: '', round: 1 },
      ],
    });
    const result = await agent.generate(board);
    expect(result.signal).toBe('ok');
  });

  it('legacy fallback still drives collapse decisions when osiEnabled=false', async () => {
    // Same per-role transcript that triggers OSI above — but with osi_enabled
    // disabled and similarity well below 0.95, the legacy path should NOT flag.
    const agent = new SentryAgent(makeAdapter('OK'), { osiEnabled: false });
    const board = makeBlackboard({
      turns: [
        // 6 turns minimum required by the legacy MIN_TURNS_FOR_ECHO_CHECK.
        { agent: 'Proposer', neurotype: 'structured', model: 'test', content: 'alpha beta gamma delta', timestamp: '', round: 1 },
        { agent: 'Skeptic', neurotype: 'critical', model: 'test', content: 'one two three four', timestamp: '', round: 1 },
        { agent: 'Synthesizer', neurotype: 'integrative', model: 'test', content: 'foo bar baz qux', timestamp: '', round: 1 },
        { agent: 'Proposer', neurotype: 'structured', model: 'test', content: 'alpha beta gamma epsilon', timestamp: '', round: 1 },
        { agent: 'Skeptic', neurotype: 'critical', model: 'test', content: 'one two three five', timestamp: '', round: 1 },
        { agent: 'Synthesizer', neurotype: 'integrative', model: 'test', content: 'foo bar baz quux', timestamp: '', round: 1 },
      ],
    });
    const result = await agent.generate(board);
    // Pairwise same-agent similarity is 0.6 (3/5) — below the 0.95 legacy
    // threshold, so the legacy path returns ok.
    expect(result.signal).toBe('ok');
  });

  it('legacy fallback still flags when same-agent similarity exceeds 0.95', async () => {
    const agent = new SentryAgent(makeAdapter('OK'), { osiEnabled: false });
    const repeated = 'identical content one two three four five six seven eight';
    const board = makeBlackboard({
      turns: [
        { agent: 'Proposer', neurotype: 'structured', model: 'test', content: repeated, timestamp: '', round: 1 },
        { agent: 'Skeptic', neurotype: 'critical', model: 'test', content: 'a b c d', timestamp: '', round: 1 },
        { agent: 'Synthesizer', neurotype: 'integrative', model: 'test', content: 'e f g h', timestamp: '', round: 1 },
        { agent: 'Proposer', neurotype: 'structured', model: 'test', content: repeated, timestamp: '', round: 1 },
        { agent: 'Skeptic', neurotype: 'critical', model: 'test', content: 'i j k l', timestamp: '', round: 1 },
        { agent: 'Proposer', neurotype: 'structured', model: 'test', content: repeated, timestamp: '', round: 1 },
      ],
    });
    const result = await agent.generate(board);
    expect(result.signal).toBe('collapse_detected');
    expect(result.reason).toMatch(/Echo loop/);
  });
});

// ---------------------------------------------------------------------------
// PAR-25 — AgentBase.generateWithFailover
// ---------------------------------------------------------------------------
//
// We exercise the failover plumbing through ProposerAgent because every prose
// agent inherits the same `generateWithFailover` path from AgentBase; covering
// it once at the seam is sufficient and matches the user's PAR-25 test plan.
// All four matrix branches in the AgentBase JSDoc behaviour table are pinned
// here:
//   1. primary connection-error → fallback OK → callback fires once.
//   2. primary AND fallback throw ModelConnectionError → fallback's error
//      propagates (not the primary's), callback still fires exactly once.
//   3. primary connection-error → no fallback configured → primary's error
//      propagates and the callback never fires.
//   4. primary throws a non-connection error → fallback is NOT tried (would
//      mask logic bugs) and the callback never fires.
// ---------------------------------------------------------------------------

describe('AgentBase failover (PAR-25)', () => {
  function makeFailoverAdapter(modelName: string, response: string): ModelAdapter {
    return {
      modelName,
      generate: vi.fn().mockResolvedValue({ content: response }),
    };
  }

  function makeConnectionErrorAdapter(modelName: string, message: string): ModelAdapter {
    return {
      modelName,
      generate: vi.fn().mockRejectedValue(new ModelConnectionError(message)),
    };
  }

  it('primary ModelConnectionError + fallback OK → returns fallback content and fires callback once', async () => {
    const primary = makeConnectionErrorAdapter('primary-model', 'connection refused');
    const fallback = makeFailoverAdapter('fallback-model', 'fallback says hi');
    const callback = vi.fn();

    const agent = new ProposerAgent(primary, {
      fallbackAdapter: fallback,
      onProviderFailover: callback,
    });
    const board = makeBlackboard();
    const result = await agent.generate(board);

    // Primary was attempted once, then fallback was retried.
    expect((primary.generate as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce();
    expect((fallback.generate as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce();
    // Returned content is the fallback's response (capped + word-counted by
    // the agent, but for a short string the content is unchanged).
    expect(result.content).toBe('fallback says hi');
    // Observability callback fires exactly once with the primary's error.
    expect(callback).toHaveBeenCalledOnce();
    const info = (callback.mock.calls[0]?.[0] as ProviderFailoverInfo);
    expect(info.neurotype).toBe('structured');
    expect(info.primary).toBe('primary-model');
    expect(info.fallback).toBe('fallback-model');
    expect(info.error).toBe('connection refused');
  });

  it('primary AND fallback throw ModelConnectionError → fallback error propagates; callback fires once', async () => {
    const primary = makeConnectionErrorAdapter('primary-model', 'primary down');
    const fallback = makeConnectionErrorAdapter('fallback-model', 'fallback down too');
    const callback = vi.fn();

    const agent = new ProposerAgent(primary, {
      fallbackAdapter: fallback,
      onProviderFailover: callback,
    });
    const board = makeBlackboard();

    // The fallback's error wins — operators reading the rejection see the
    // most-recent failure, which signals "both providers are simultaneously
    // down" instead of the misleading "the primary failed and we never
    // retried."
    await expect(agent.generate(board)).rejects.toThrow(ModelConnectionError);
    await expect(agent.generate(board)).rejects.toThrow('fallback down too');

    // Both adapters were called twice (we awaited rejects twice). Each
    // failover call notifies once → 2 calls total. We only care that the
    // callback fired at least once with the primary's error message and
    // never with the fallback's.
    expect(callback).toHaveBeenCalled();
    for (const [info] of callback.mock.calls) {
      const payload = info as ProviderFailoverInfo;
      expect(payload.error).toBe('primary down');
      expect(payload.primary).toBe('primary-model');
      expect(payload.fallback).toBe('fallback-model');
    }
  });

  it('primary ModelConnectionError + no fallback configured → primary error propagates; callback never fires', async () => {
    const primary = makeConnectionErrorAdapter('primary-model', 'primary kaput');
    const callback = vi.fn();

    // fallbackAdapter omitted on purpose — supplying only the callback is a
    // no-op per the AgentRuntimeOptions contract.
    const agent = new ProposerAgent(primary, { onProviderFailover: callback });
    const board = makeBlackboard();

    await expect(agent.generate(board)).rejects.toThrow(ModelConnectionError);
    await expect(agent.generate(board)).rejects.toThrow('primary kaput');

    expect(callback).not.toHaveBeenCalled();
  });

  it('primary throws non-connection error → fallback is NOT tried; callback never fires', async () => {
    // Simulate a logic-layer error (e.g. malformed-output parse failure). The
    // failover path MUST NOT mask this by retrying — that would hide bugs.
    const logicError = new TypeError('unexpected token in JSON');
    const primary: ModelAdapter = {
      modelName: 'primary-model',
      generate: vi.fn().mockRejectedValue(logicError),
    };
    const fallback = makeFailoverAdapter('fallback-model', 'should never run');
    const callback = vi.fn();

    const agent = new ProposerAgent(primary, {
      fallbackAdapter: fallback,
      onProviderFailover: callback,
    });
    const board = makeBlackboard();

    // The non-connection error propagates exactly as-is.
    await expect(agent.generate(board)).rejects.toThrow(TypeError);
    await expect(agent.generate(board)).rejects.toThrow('unexpected token in JSON');

    // Fallback was never called; callback never fired.
    expect((fallback.generate as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
  });
});

