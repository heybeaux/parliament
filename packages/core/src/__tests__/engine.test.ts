import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Blackboard, SynthesizerMeta } from '../types.js';
import type { Agent, AgentResult } from '../agents/base.js';
import type { SynthesizerResult } from '../agents/synthesizer.js';
import type { SentryResult } from '../agents/sentry.js';
import { DeliberationEngine } from '../engine.js';
import type { DeliberationConfig } from '../engine.js';

// ---------------------------------------------------------------------------
// Mock agent factories
// ---------------------------------------------------------------------------

function makeAgent(role: string, neurotype: string, content: string): Agent {
  return {
    role,
    neurotype,
    modelName: 'test-model',
    generate: vi.fn().mockResolvedValue({ content, truncated: false } satisfies AgentResult),
  };
}

function makeSentryAgent(signal: SentryResult['signal'] = 'ok'): {
  role: string;
  neurotype: string;
  generate: ReturnType<typeof vi.fn>;
} {
  return {
    role: 'Sentry',
    neurotype: 'monitoring',
    generate: vi.fn().mockResolvedValue({ signal, reason: 'test' } satisfies SentryResult),
  };
}

/**
 * Mock synthesizer factory.
 *
 * Defaults to `consensus = (confidence >= 0.7)` so legacy tests that only
 * thought about confidence still get the consensus signal they expect. Pass
 * `metaOverrides` to decouple consensus from confidence — that's how the
 * "high confidence but no consensus" and "fail-closed" cases below are
 * expressed.
 */
function makeSynthesizerAgent(
  confidence: number,
  content = 'Synthesis content',
  metaOverrides: Partial<SynthesizerMeta> = {},
): {
  role: string;
  neurotype: string;
  generate: ReturnType<typeof vi.fn>;
} {
  const meta: SynthesizerMeta = {
    confidence,
    consensus: confidence >= 0.7,
    agreed: [],
    unresolved: [],
    ...metaOverrides,
  };
  return {
    role: 'Synthesizer',
    neurotype: 'integrative',
    generate: vi.fn().mockResolvedValue({
      content,
      truncated: false,
      confidence: meta.confidence,
      meta,
    } satisfies SynthesizerResult),
  };
}

/**
 * Builds a complete DeliberationConfig with sensible defaults.
 * Individual fields can be overridden via the partial parameter.
 */
function makeConfig(overrides: Partial<DeliberationConfig> = {}): DeliberationConfig {
  return {
    maxRounds: 5,
    redAgentInterval: 3,
    confidenceThreshold: 0.7,
    agents: {
      proposer: makeAgent('Proposer', 'structured', 'Proposer content'),
      skeptic: makeAgent('Skeptic', 'critical', 'Skeptic content'),
      synthesizer: makeSynthesizerAgent(0.5) as unknown as import('../agents/synthesizer.js').SynthesizerAgent,
      redAgent: makeAgent('RedAgent', 'disruptive', 'RedAgent content'),
      sentry: makeSentryAgent('ok') as unknown as import('../agents/sentry.js').SentryAgent,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DeliberationEngine', () => {
  let engine: DeliberationEngine;

  beforeEach(() => {
    engine = new DeliberationEngine();
  });

  // -------------------------------------------------------------------------
  // Shape of the result
  // -------------------------------------------------------------------------

  it('returns a DeliberationResult with all required fields', async () => {
    const config = makeConfig({ maxRounds: 2 });
    const result = await engine.run('test topic', config);

    expect(result).toMatchObject({
      topic: 'test topic',
      turns: expect.any(Array),
      conflicts: expect.any(Array),
      residueScore: expect.any(Number),
      resolved: expect.any(Boolean),
      terminationReason: expect.any(String),
      totalRounds: expect.any(Number),
      started_at: expect.any(String),
      completed_at: expect.any(String),
    });

    // synthesis and split can be null/object
    expect('synthesis' in result).toBe(true);
    expect('split' in result).toBe(true);

    // started_at must precede completed_at.
    expect(Date.parse(result.completed_at)).toBeGreaterThanOrEqual(
      Date.parse(result.started_at),
    );

    // Every recorded turn must carry a 1-indexed round number bounded by totalRounds.
    for (const turn of result.turns) {
      expect(typeof turn.round).toBe('number');
      expect(turn.round).toBeGreaterThanOrEqual(1);
      expect(turn.round).toBeLessThanOrEqual(result.totalRounds);
    }
  });

  it('records the loop round on every turn', async () => {
    const config = makeConfig({
      maxRounds: 3,
      redAgentInterval: 2,
      agents: {
        ...makeConfig().agents,
        synthesizer: makeSynthesizerAgent(0.3) as unknown as import('../agents/synthesizer.js').SynthesizerAgent,
      },
    });

    const result = await engine.run('round-tagging topic', config);

    // Proposer fires only on round 1.
    const proposerTurns = result.turns.filter((t) => t.agent === 'Proposer');
    expect(proposerTurns.every((t) => t.round === 1)).toBe(true);

    // RedAgent injection at interval=2 means we expect a RedAgent turn at round 2.
    const redTurns = result.turns.filter((t) => t.agent === 'RedAgent');
    expect(redTurns.some((t) => t.round === 2)).toBe(true);

    // Round numbers should appear in non-decreasing order across the transcript.
    const rounds = result.turns.map((t) => t.round);
    for (let i = 1; i < rounds.length; i++) {
      expect(rounds[i]!).toBeGreaterThanOrEqual(rounds[i - 1]!);
    }
  });

  // -------------------------------------------------------------------------
  // Consensus termination
  // -------------------------------------------------------------------------

  it('terminates with consensus when Synthesizer confidence >= threshold', async () => {
    const config = makeConfig({
      confidenceThreshold: 0.7,
      agents: {
        ...makeConfig().agents,
        synthesizer: makeSynthesizerAgent(0.9, 'High-confidence synthesis') as unknown as import('../agents/synthesizer.js').SynthesizerAgent,
      },
    });

    const result = await engine.run('consensus topic', config);

    expect(result.terminationReason).toBe('consensus');
    expect(result.synthesis).toBe('High-confidence synthesis');
    expect(result.split).toBeNull();
  });

  it('terminates with consensus when synthesizer meta has consensus=true and confidence>=threshold', async () => {
    const config = makeConfig({
      confidenceThreshold: 0.7,
      agents: {
        ...makeConfig().agents,
        synthesizer: makeSynthesizerAgent(0.9, 'Resolved synthesis', {
          consensus: true,
        }) as unknown as import('../agents/synthesizer.js').SynthesizerAgent,
      },
    });

    const result = await engine.run('explicit consensus topic', config);

    expect(result.terminationReason).toBe('consensus');
    expect(result.synthesis).toBe('Resolved synthesis');
  });

  it('does NOT terminate with consensus when meta.consensus=false even at high confidence', async () => {
    // High confidence (0.9) but the synthesizer itself says the debate is
    // unresolved. Engine must continue rather than termination on confidence
    // alone — that's the entire point of removing the regex-on-prose path.
    const config = makeConfig({
      maxRounds: 2,
      redAgentInterval: 99,
      confidenceThreshold: 0.7,
      agents: {
        ...makeConfig().agents,
        synthesizer: makeSynthesizerAgent(0.9, 'Confident but contested', {
          consensus: false,
        }) as unknown as import('../agents/synthesizer.js').SynthesizerAgent,
      },
    });

    const result = await engine.run('no-consensus topic', config);

    expect(result.terminationReason).toBe('max_rounds');
    expect(result.totalRounds).toBe(2);
    expect(result.synthesis).toBeNull();
  });

  it('does NOT terminate when synthesizer fail-closed (confidence=0, consensus=false); runs to max_rounds', async () => {
    const failClosedSynth = makeSynthesizerAgent(0, 'truncated raw text', {
      consensus: false,
      agreed: [],
      unresolved: [],
    });

    const config = makeConfig({
      maxRounds: 3,
      redAgentInterval: 99,
      confidenceThreshold: 0.7,
      agents: {
        ...makeConfig().agents,
        synthesizer: failClosedSynth as unknown as import('../agents/synthesizer.js').SynthesizerAgent,
      },
    });

    const result = await engine.run('failsafe topic', config);

    expect(result.terminationReason).toBe('max_rounds');
    expect(result.totalRounds).toBe(3);
    // Engine kept running — synthesizer was called once per round.
    expect(failClosedSynth.generate).toHaveBeenCalledTimes(3);
  });

  it('consensus terminates on exactly the threshold value', async () => {
    const config = makeConfig({
      confidenceThreshold: 0.7,
      agents: {
        ...makeConfig().agents,
        synthesizer: makeSynthesizerAgent(0.7, 'Exact threshold synthesis') as unknown as import('../agents/synthesizer.js').SynthesizerAgent,
      },
    });

    const result = await engine.run('threshold topic', config);

    expect(result.terminationReason).toBe('consensus');
    expect(result.synthesis).toBe('Exact threshold synthesis');
  });

  // -------------------------------------------------------------------------
  // Echo-loop termination (first sentry check)
  // -------------------------------------------------------------------------

  it('terminates with echo_loop when first Sentry check returns collapse_detected', async () => {
    const config = makeConfig({
      agents: {
        ...makeConfig().agents,
        sentry: makeSentryAgent('collapse_detected') as unknown as import('../agents/sentry.js').SentryAgent,
      },
    });

    const result = await engine.run('echo topic', config);

    expect(result.terminationReason).toBe('echo_loop');
    expect(result.synthesis).toBeNull();
  });

  // -------------------------------------------------------------------------
  // sentry_collapse_detected (second sentry check, after synthesizer)
  // -------------------------------------------------------------------------

  it('terminates with echo_loop when second Sentry check (after Synthesizer) returns collapse_detected', async () => {
    // Synthesizer never reaches threshold (confidence 0.3), so we reach the
    // second sentry check.  Make the sentry return ok on first call and
    // collapse_detected on second.
    const sentryMock = {
      role: 'Sentry',
      neurotype: 'monitoring',
      generate: vi.fn()
        .mockResolvedValueOnce({ signal: 'ok', reason: 'first' })
        .mockResolvedValueOnce({ signal: 'collapse_detected', reason: 'second' }),
    };

    const config = makeConfig({
      agents: {
        ...makeConfig().agents,
        synthesizer: makeSynthesizerAgent(0.3) as unknown as import('../agents/synthesizer.js').SynthesizerAgent,
        sentry: sentryMock as unknown as import('../agents/sentry.js').SentryAgent,
      },
    });

    const result = await engine.run('collapse after synth', config);

    expect(result.terminationReason).toBe('echo_loop');
    expect(sentryMock.generate).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  // Max-rounds termination
  // -------------------------------------------------------------------------

  it('terminates with max_rounds after maxRounds when no consensus or collapse', async () => {
    const config = makeConfig({
      maxRounds: 3,
      // Low confidence so consensus never triggered; redAgentInterval > maxRounds
      redAgentInterval: 99,
      agents: {
        ...makeConfig().agents,
        synthesizer: makeSynthesizerAgent(0.3) as unknown as import('../agents/synthesizer.js').SynthesizerAgent,
      },
    });

    const result = await engine.run('max rounds topic', config);

    expect(result.terminationReason).toBe('max_rounds');
    expect(result.totalRounds).toBe(3);
  });

  // -------------------------------------------------------------------------
  // Unresolved split
  // -------------------------------------------------------------------------

  it('sets synthesis=null and split populated when confidence never reaches threshold', async () => {
    const config = makeConfig({
      maxRounds: 2,
      redAgentInterval: 99,
      agents: {
        ...makeConfig().agents,
        synthesizer: makeSynthesizerAgent(0.3) as unknown as import('../agents/synthesizer.js').SynthesizerAgent,
      },
    });

    const result = await engine.run('split topic', config);

    expect(result.synthesis).toBeNull();
    expect(result.split).not.toBeNull();
    expect(result.split).toMatchObject({
      positions: expect.any(Object),
      irreconcilable: expect.any(Boolean),
    });
    expect(Object.keys(result.split!.positions).length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // Residue scoring
  // -------------------------------------------------------------------------

  it('residueScore=0 when all conflicts are resolved', async () => {
    // We need the Skeptic to add conflicts that are then marked resolved.
    // The easiest approach is to mock the skeptic to push a resolved conflict.
    const resolvedSkepticMock: Agent = {
      role: 'Skeptic',
      neurotype: 'critical',
      modelName: 'test-model',
      generate: vi.fn().mockImplementation(async (board: Blackboard) => {
        board.conflicts.push({
          between: ['Skeptic', 'Proposer'],
          description: 'A resolved conflict',
          resolved: true,
        });
        return { content: 'Skeptic content', truncated: false };
      }),
    };

    const config = makeConfig({
      maxRounds: 1,
      redAgentInterval: 99,
      agents: {
        ...makeConfig().agents,
        skeptic: resolvedSkepticMock,
        synthesizer: makeSynthesizerAgent(0.3) as unknown as import('../agents/synthesizer.js').SynthesizerAgent,
      },
    });

    const result = await engine.run('resolved topic', config);

    expect(result.residueScore).toBe(0);
  });

  it('residueScore > 0 when unresolved conflicts remain', async () => {
    // Skeptic pushes an unresolved conflict.
    const unresolvedSkepticMock: Agent = {
      role: 'Skeptic',
      neurotype: 'critical',
      modelName: 'test-model',
      generate: vi.fn().mockImplementation(async (board: Blackboard) => {
        board.conflicts.push({
          between: ['Skeptic', 'Proposer'],
          description: 'An unresolved conflict',
          resolved: false,
        });
        return { content: 'Skeptic content', truncated: false };
      }),
    };

    const config = makeConfig({
      maxRounds: 1,
      redAgentInterval: 99,
      agents: {
        ...makeConfig().agents,
        skeptic: unresolvedSkepticMock,
        synthesizer: makeSynthesizerAgent(0.3) as unknown as import('../agents/synthesizer.js').SynthesizerAgent,
      },
    });

    const result = await engine.run('unresolved topic', config);

    expect(result.residueScore).toBeGreaterThan(0);
    expect(result.residueScore).toBeLessThanOrEqual(1);
  });

  it('residueScore = 0 when there are no conflicts at all', async () => {
    // Skeptic does NOT push any conflict.
    const noConflictSkeptic: Agent = {
      role: 'Skeptic',
      neurotype: 'critical',
      modelName: 'test-model',
      generate: vi.fn().mockResolvedValue({ content: 'No conflicts today', truncated: false }),
    };

    const config = makeConfig({
      maxRounds: 1,
      redAgentInterval: 99,
      agents: {
        ...makeConfig().agents,
        skeptic: noConflictSkeptic,
        synthesizer: makeSynthesizerAgent(0.3) as unknown as import('../agents/synthesizer.js').SynthesizerAgent,
      },
    });

    const result = await engine.run('no conflict topic', config);

    expect(result.residueScore).toBe(0);
  });

  // -------------------------------------------------------------------------
  // RedAgent injection
  // -------------------------------------------------------------------------

  it('injects RedAgent at the correct interval (every N rounds)', async () => {
    const redAgentMock = makeAgent('RedAgent', 'disruptive', 'Red disruption');

    const config = makeConfig({
      maxRounds: 6,
      redAgentInterval: 3,
      agents: {
        ...makeConfig().agents,
        redAgent: redAgentMock,
        synthesizer: makeSynthesizerAgent(0.3) as unknown as import('../agents/synthesizer.js').SynthesizerAgent,
      },
    });

    const result = await engine.run('interval topic', config);

    // RedAgent should be called for round 3 and round 6.
    expect(redAgentMock.generate).toHaveBeenCalledTimes(2);

    // Turns should contain RedAgent entries.
    const redTurns = result.turns.filter((t) => t.agent === 'RedAgent');
    expect(redTurns).toHaveLength(2);
  });

  it('does not inject RedAgent when round is not a multiple of the interval', async () => {
    const redAgentMock = makeAgent('RedAgent', 'disruptive', 'Red disruption');

    const config = makeConfig({
      maxRounds: 2,
      redAgentInterval: 5,
      agents: {
        ...makeConfig().agents,
        redAgent: redAgentMock,
        synthesizer: makeSynthesizerAgent(0.3) as unknown as import('../agents/synthesizer.js').SynthesizerAgent,
      },
    });

    await engine.run('no red topic', config);

    expect(redAgentMock.generate).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Config not mutated
  // -------------------------------------------------------------------------

  it('does not mutate the config object passed in', async () => {
    const config = makeConfig({ maxRounds: 2 });
    const agentsBefore = config.agents;
    const maxRoundsBefore = config.maxRounds;
    const thresholdBefore = config.confidenceThreshold;
    const intervalBefore = config.redAgentInterval;

    await engine.run('mutation test', config);

    // Primitive values must be unchanged.
    expect(config.maxRounds).toBe(maxRoundsBefore);
    expect(config.confidenceThreshold).toBe(thresholdBefore);
    expect(config.redAgentInterval).toBe(intervalBefore);
    // The agents reference must not be replaced.
    expect(config.agents).toBe(agentsBefore);
  });

  // -------------------------------------------------------------------------
  // Proposer runs only on round 1
  // -------------------------------------------------------------------------

  it('calls Proposer only once (round 1) regardless of maxRounds', async () => {
    const proposerMock = makeAgent('Proposer', 'structured', 'Proposer once');

    const config = makeConfig({
      maxRounds: 4,
      redAgentInterval: 99,
      agents: {
        ...makeConfig().agents,
        proposer: proposerMock,
        synthesizer: makeSynthesizerAgent(0.3) as unknown as import('../agents/synthesizer.js').SynthesizerAgent,
      },
    });

    await engine.run('proposer once topic', config);

    expect(proposerMock.generate).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // split.irreconcilable reflects residueScore > 0.5
  // -------------------------------------------------------------------------

  it('split.irreconcilable is true when residueScore > 0.5', async () => {
    const unresolvedSkeptic: Agent = {
      role: 'Skeptic',
      neurotype: 'critical',
      modelName: 'test-model',
      generate: vi.fn().mockImplementation(async (board: Blackboard) => {
        board.conflicts.push({ between: ['Skeptic', 'Proposer'], description: 'conflict', resolved: false });
        return { content: 'critique', truncated: false };
      }),
    };

    const config = makeConfig({
      maxRounds: 1,
      redAgentInterval: 99,
      agents: {
        ...makeConfig().agents,
        skeptic: unresolvedSkeptic,
        synthesizer: makeSynthesizerAgent(0.3) as unknown as import('../agents/synthesizer.js').SynthesizerAgent,
      },
    });

    const result = await engine.run('irreconcilable topic', config);

    // With one unresolved conflict out of one, residueScore = 1.0 > 0.5.
    expect(result.split?.irreconcilable).toBe(true);
  });

  // -------------------------------------------------------------------- //
  // PAR-10: per-turn enrichment fields and lifecycle events.
  //
  // The legacy `run()` path is the simplest place to assert these because the
  // pipeline is fixed (Proposer/Skeptic/Synthesizer per round, no parallel
  // siblings). The topology path has its own tests in topology-engine.test.ts
  // covering parallel_group plumbing.
  // -------------------------------------------------------------------- //
  describe('PAR-10 turn enrichment + deliberation events', () => {
    it('populates model_name, neurotype_posture, word_count, and convergence_delta on every fresh turn', async () => {
      const config = makeConfig({
        maxRounds: 2,
        redAgentInterval: 99,
        // Stay below threshold so the loop exhausts max_rounds and we get
        // turns from both rounds 1 and 2 (the round-2 delta should be
        // computable).
        agents: {
          ...makeConfig().agents,
          synthesizer: makeSynthesizerAgent(0.3, 'Synth round') as unknown as import('../agents/synthesizer.js').SynthesizerAgent,
        },
      });

      const result = await engine.run('enrichment topic', config);

      // Every turn must carry the four PAR-10 enrichment fields. The local
      // mock synthesizer factory in this file doesn't set `modelName`, so we
      // assert `model_name` mirrors `model` rather than asserting either is a
      // string outright.
      for (const t of result.turns) {
        expect(t.model_name).toBe(t.model);
        expect(typeof t.neurotype_posture).toBe('string');
        // Mocks don't declare posture, so the engine falls back to neurotype.
        expect(t.neurotype_posture).toBe(t.neurotype);
        expect(typeof t.word_count).toBe('number');
        expect(t.word_count).toBeGreaterThan(0);
        expect(typeof t.convergence_delta).toBe('number');
      }

      // Non-synthesizer agents in the local mocks DO set modelName, so those
      // turns must carry a string-valued model_name.
      const nonSynth = result.turns.filter((t) => t.agent !== 'Synthesizer');
      for (const t of nonSynth) {
        expect(typeof t.model_name).toBe('string');
        expect((t.model_name as string).length).toBeGreaterThan(0);
      }

      // Round-1 turns: convergence_delta = 0 (no prior synth).
      const round1 = result.turns.filter((t) => t.round === 1);
      for (const t of round1) {
        expect(t.convergence_delta).toBe(0);
      }

      // Round-2 turns: synth(R-1) - synth(R-2 default 0) = 0.3 - 0 = 0.3.
      const round2 = result.turns.filter((t) => t.round === 2);
      expect(round2.length).toBeGreaterThan(0);
      for (const t of round2) {
        expect(t.convergence_delta).toBe(0.3);
      }
    });

    it('emits round_start, synthesis_attempt, round_end, and termination events', async () => {
      const config = makeConfig({ maxRounds: 2, redAgentInterval: 99 });
      const result = await engine.run('lifecycle topic', config);

      const kinds = result.events.map((e) => e.kind);

      // Two rounds → two round_starts, two round_ends, two synthesis_attempts.
      expect(kinds.filter((k) => k === 'round_start')).toHaveLength(2);
      expect(kinds.filter((k) => k === 'round_end')).toHaveLength(2);
      expect(kinds.filter((k) => k === 'synthesis_attempt')).toHaveLength(2);

      // Termination always fires exactly once at the end.
      expect(kinds.filter((k) => k === 'termination')).toHaveLength(1);
      const termination = result.events[result.events.length - 1]!;
      expect(termination.kind).toBe('termination');
      expect(termination.data).toMatchObject({
        reason: 'max_rounds',
        totalRounds: 2,
      });

      // Every event carries a timestamp (PAR-10 requirement).
      for (const e of result.events) {
        expect(typeof e.timestamp).toBe('string');
        expect(e.timestamp!.length).toBeGreaterThan(0);
      }
    });

    it('emits consensus_reached when the synthesizer crosses the threshold', async () => {
      // 0.9 confidence with consensus=true (default) terminates round 1.
      const config = makeConfig({
        maxRounds: 5,
        redAgentInterval: 99,
        agents: {
          ...makeConfig().agents,
          synthesizer: makeSynthesizerAgent(0.9) as unknown as import('../agents/synthesizer.js').SynthesizerAgent,
        },
      });

      const result = await engine.run('consensus topic', config);

      expect(result.terminationReason).toBe('consensus');

      const kinds = result.events.map((e) => e.kind);
      expect(kinds).toContain('consensus_reached');
      expect(kinds).toContain('termination');

      // Termination event records the reason.
      const termination = result.events.find((e) => e.kind === 'termination')!;
      expect(termination.data).toMatchObject({ reason: 'consensus' });
    });
  });

  it('split.irreconcilable is false when residueScore <= 0.5', async () => {
    // Two conflicts: one resolved, one unresolved.
    // Weights (position_from_end / total):
    //   index 0 (from end = 1): weight = 1 + 1/2 = 1.5
    //   index 1 (from end = 0): weight = 1 + 0/2 = 1.0
    // Total weight = 2.5; unresolved weight (index 1 = unresolved): 1.0
    // residueScore = 1.0 / 2.5 = 0.4 <= 0.5 → irreconcilable = false
    let callCount = 0;
    const mixedSkeptic: Agent = {
      role: 'Skeptic',
      neurotype: 'critical',
      modelName: 'test-model',
      generate: vi.fn().mockImplementation(async (board: Blackboard) => {
        callCount++;
        board.conflicts.push({
          between: ['Skeptic', 'Proposer'],
          description: `conflict ${callCount}`,
          resolved: callCount === 1, // first conflict resolved, second not
        });
        return { content: 'critique', truncated: false };
      }),
    };

    const config = makeConfig({
      maxRounds: 2,
      redAgentInterval: 99,
      agents: {
        ...makeConfig().agents,
        skeptic: mixedSkeptic,
        synthesizer: makeSynthesizerAgent(0.3) as unknown as import('../agents/synthesizer.js').SynthesizerAgent,
      },
    });

    const result = await engine.run('reconcilable topic', config);

    expect(result.residueScore).toBeLessThanOrEqual(0.5);
    expect(result.split?.irreconcilable).toBe(false);
  });
});
