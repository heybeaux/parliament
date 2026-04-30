import { describe, it, expect, vi } from 'vitest';
import { parse } from 'smol-toml';
import type { Agent, AgentResult } from '../agents/base.js';
import type { SentryResult } from '../agents/sentry.js';
import type { SynthesizerResult } from '../agents/synthesizer.js';
import type {
  SentryAgent as SentryAgentType,
} from '../agents/sentry.js';
import type {
  SynthesizerAgent as SynthesizerAgentType,
} from '../agents/synthesizer.js';
import type { Blackboard, SynthesizerMeta } from '../types.js';
import {
  DeliberationEngine,
  type NeurotypeResolver,
  type TopologyDeliberationConfig,
  type TopologyRuntimeLogger,
} from '../engine.js';
import { loadTopology } from '../topology/index.js';
import type { TopologyConfig, TopologyStep } from '../topology/index.js';

/**
 * Engine ↔ topology runtime integration tests.
 *
 * Focus: the four acceptance criteria for the engine-wiring task —
 *   AC1: Engine accepts a TopologyConfig and runs the active preset to
 *        completion.
 *   AC2: Sentry runs out-of-band on every preset.
 *   AC3: Per-turn metadata (model_name, neurotype_posture, word_count) is
 *        populated on every turn.
 *   AC4: `optional: true` is parsed but not evaluated for skip — the engine
 *        logs the field and runs the step anyway.
 *
 * These tests deliberately use mock agents so the runtime contract is
 * exercised without spinning up real model adapters.
 */

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function makeAgent(role: string, neurotype: string, content: string, modelName = 'mock-model'): Agent {
  return {
    role,
    neurotype,
    modelName,
    generate: vi.fn().mockResolvedValue({ content, truncated: false } satisfies AgentResult),
  };
}

function makeSentry(signal: SentryResult['signal'] = 'ok'): SentryAgentType {
  return {
    role: 'Sentry',
    neurotype: 'monitoring',
    generate: vi.fn().mockResolvedValue({ signal, reason: 'mock' } satisfies SentryResult),
  } as unknown as SentryAgentType;
}

function makeSynth(
  confidence: number,
  content = 'Synthesis prose',
  metaOverrides: Partial<SynthesizerMeta> = {},
): SynthesizerAgentType {
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
    modelName: 'mock-synth-model',
    generate: vi.fn().mockResolvedValue({
      content,
      truncated: false,
      confidence: meta.confidence,
      meta,
    } satisfies SynthesizerResult),
  } as unknown as SynthesizerAgentType;
}

/**
 * Build a TopologyConfig from a TOML snippet. Mirrors how production code
 * loads `parliament.toml` via smol-toml + loadTopology.
 */
function buildTopology(toml: string): TopologyConfig {
  return loadTopology(parse(toml));
}

/**
 * Builds a NeurotypeResolver backed by a static map of step.id → Agent.
 * Each entry is a fresh mock instance so per-step call counts are
 * independently introspectable.
 */
function makeResolver(map: Record<string, Agent>): NeurotypeResolver {
  return (step: TopologyStep): Agent => {
    const agent = map[step.id];
    if (!agent) {
      throw new Error(`test bug: no mock agent registered for step "${step.id}"`);
    }
    return agent;
  };
}

function makeBaseConfig(
  topology: TopologyConfig,
  agents: Record<string, Agent>,
  overrides: Partial<TopologyDeliberationConfig> = {},
): TopologyDeliberationConfig {
  return {
    maxRounds: 2,
    redAgentInterval: 99,
    confidenceThreshold: 0.7,
    topology,
    resolveNeurotype: makeResolver(agents),
    synthesizer: makeSynth(0.3),
    redAgent: makeAgent('RedAgent', 'disruptive', 'Red disruption'),
    sentry: makeSentry('ok'),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// AC1 — engine accepts a TopologyConfig and runs the active preset
// ---------------------------------------------------------------------------

describe('runTopology — AC1 (consumes TopologyConfig)', () => {
  it('runs the built-in Debate preset to completion', async () => {
    const topology = buildTopology(`
[topology]
active = "debate"
`);
    const proposer = makeAgent('Proposer', 'proposer', 'Proposer says X');
    const skeptic = makeAgent('Skeptic', 'skeptic', 'Skeptic counters');
    const config = makeBaseConfig(topology, { proposer, skeptic });

    const engine = new DeliberationEngine();
    const result = await engine.runTopology('Should X be Y?', config);

    expect(result.terminationReason).toBe('max_rounds');
    expect(result.totalRounds).toBe(2);
    // Proposer + Skeptic + Synthesizer each fire 2× (once per round).
    expect((proposer.generate as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(2);
    expect((skeptic.generate as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(2);
    // Resolved synthesizer is on the config object directly.
    expect((config.synthesizer.generate as ReturnType<typeof vi.fn>))
      .toHaveBeenCalledTimes(2);
  });

  it('runs a user-defined preset to completion in declared step order', async () => {
    const topology = buildTopology(`
[topology]
active = "trio"

[topology.presets.trio]
name = "Trio"
description = "Three-step user preset."
best_for = "Engine integration testing."
steps = [
  { id = "first", neurotype = "proposer" },
  { id = "second", neurotype = "skeptic" },
  { id = "third", neurotype = "translator" },
]
`);
    const first = makeAgent('Proposer', 'proposer', 'one');
    const second = makeAgent('Skeptic', 'skeptic', 'two');
    const third = makeAgent('Translator', 'translator', 'three');

    const config = makeBaseConfig(topology, { first, second, third }, { maxRounds: 1 });

    const engine = new DeliberationEngine();
    const result = await engine.runTopology('three-step topic', config);

    // Step order on the transcript matches the preset's declared order.
    const stepRoles = result.turns
      .filter((t) => t.agent !== 'Synthesizer')
      .map((t) => t.agent);
    expect(stepRoles).toEqual(['Proposer', 'Skeptic', 'Translator']);
  });

  it('terminates with consensus when synthesizer votes consensus + meets threshold', async () => {
    const topology = buildTopology(`
[topology]
active = "debate"
`);
    const proposer = makeAgent('Proposer', 'proposer', 'p');
    const skeptic = makeAgent('Skeptic', 'skeptic', 's');
    const config = makeBaseConfig(
      topology,
      { proposer, skeptic },
      {
        synthesizer: makeSynth(0.9, 'High-confidence synthesis', { consensus: true }),
      },
    );

    const engine = new DeliberationEngine();
    const result = await engine.runTopology('consensus topic', config);

    expect(result.terminationReason).toBe('consensus');
    expect(result.synthesis).toBe('High-confidence synthesis');
    expect(result.split).toBeNull();
  });

  it('exposes the active preset on blackboard metadata for downstream consumers', async () => {
    const topology = buildTopology(`
[topology]
active = "debate"
`);
    const proposer = makeAgent('Proposer', 'proposer', 'p');
    const skeptic = makeAgent('Skeptic', 'skeptic', 's');
    const config = makeBaseConfig(topology, { proposer, skeptic }, { maxRounds: 1 });

    // Capture the blackboard metadata via a sentry that peeks at it.
    let observedActive: unknown;
    const introspectingSentry = {
      role: 'Sentry',
      neurotype: 'monitoring',
      generate: vi.fn().mockImplementation(async (board: Blackboard) => {
        observedActive = board.metadata['active_preset'];
        return { signal: 'ok', reason: 'peek' } satisfies SentryResult;
      }),
    } as unknown as SentryAgentType;

    const engine = new DeliberationEngine();
    await engine.runTopology('peek topic', { ...config, sentry: introspectingSentry });

    expect(observedActive).toBe('debate');
  });
});

// ---------------------------------------------------------------------------
// AC2 — Sentry runs out-of-band on every preset
// ---------------------------------------------------------------------------

describe('runTopology — AC2 (Sentry out-of-band)', () => {
  it('invokes Sentry after every step, not as a step', async () => {
    const topology = buildTopology(`
[topology]
active = "debate"
`);
    const proposer = makeAgent('Proposer', 'proposer', 'p');
    const skeptic = makeAgent('Skeptic', 'skeptic', 's');
    const sentry = makeSentry('ok');

    const config = makeBaseConfig(topology, { proposer, skeptic }, { maxRounds: 1, sentry });

    const engine = new DeliberationEngine();
    const result = await engine.runTopology('out-of-band topic', config);

    // Per round: 1 Sentry per step (2 steps) + 1 Sentry post-synthesizer = 3.
    expect((sentry.generate as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(3);

    // Sentry MUST never appear as a transcript turn — it is structural
    // infrastructure, not a posture, so the engine never records a Sentry turn.
    const sentryTurns = result.turns.filter((t) => t.agent === 'Sentry');
    expect(sentryTurns).toHaveLength(0);
  });

  it('terminates with echo_loop when Sentry signals collapse mid-step phase', async () => {
    const topology = buildTopology(`
[topology]
active = "debate"
`);
    const proposer = makeAgent('Proposer', 'proposer', 'p');
    const skeptic = makeAgent('Skeptic', 'skeptic', 's');

    // Sentry returns 'ok' for the first step, 'collapse_detected' for the second.
    const flakyCollapseSentry = {
      role: 'Sentry',
      neurotype: 'monitoring',
      generate: vi.fn()
        .mockResolvedValueOnce({ signal: 'ok', reason: 'first' })
        .mockResolvedValueOnce({ signal: 'collapse_detected', reason: 'second' }),
    } as unknown as SentryAgentType;

    const config = makeBaseConfig(
      topology,
      { proposer, skeptic },
      { maxRounds: 3, sentry: flakyCollapseSentry },
    );

    const engine = new DeliberationEngine();
    const result = await engine.runTopology('mid-step collapse', config);

    expect(result.terminationReason).toBe('echo_loop');
    // Both step agents fire (once each) before the collapse — the second
    // step's Sentry check is what terminates the round.
    expect((proposer.generate as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect((skeptic.generate as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    // Synthesizer never fires when Sentry collapses during the step phase.
    expect((config.synthesizer.generate as ReturnType<typeof vi.fn>))
      .not.toHaveBeenCalled();
  });

  it('terminates with echo_loop when Sentry signals collapse after synthesizer', async () => {
    const topology = buildTopology(`
[topology]
active = "debate"
`);
    const proposer = makeAgent('Proposer', 'proposer', 'p');
    const skeptic = makeAgent('Skeptic', 'skeptic', 's');

    // 2 steps × 1 Sentry-per-step = 2 ok signals before the post-synth check.
    // The 3rd Sentry call (post-synthesizer) returns collapse_detected.
    const postSynthSentry = {
      role: 'Sentry',
      neurotype: 'monitoring',
      generate: vi.fn()
        .mockResolvedValueOnce({ signal: 'ok', reason: 'step-1' })
        .mockResolvedValueOnce({ signal: 'ok', reason: 'step-2' })
        .mockResolvedValueOnce({ signal: 'collapse_detected', reason: 'post-synth' }),
    } as unknown as SentryAgentType;

    const config = makeBaseConfig(
      topology,
      { proposer, skeptic },
      { sentry: postSynthSentry },
    );

    const engine = new DeliberationEngine();
    const result = await engine.runTopology('post-synth collapse', config);

    expect(result.terminationReason).toBe('echo_loop');
    expect((postSynthSentry.generate as ReturnType<typeof vi.fn>))
      .toHaveBeenCalledTimes(3);
  });

  it('rejects any preset that smuggles Sentry into steps (loader-level guarantee)', () => {
    // The engine relies on the loader to forbid Sentry as a step. We verify
    // the same invariant from the engine's perspective by trying to load a
    // preset that includes Sentry — the loader throws, so the engine never
    // sees a malformed TopologyConfig.
    expect(() =>
      buildTopology(`
[topology]
active = "bad"

[topology.presets.bad]
name = "Bad"
description = "Tries to make Sentry steppable."
best_for = "Negative test for the engine's Sentry invariant."
steps = [{ id = "watch", neurotype = "sentry" }]
`),
    ).toThrowError(/sentry/i);
  });
});

// ---------------------------------------------------------------------------
// AC3 — per-turn metadata is populated
// ---------------------------------------------------------------------------

describe('runTopology — AC3 (per-turn metadata)', () => {
  it('populates model, neurotype, and word_count on every recorded turn', async () => {
    const topology = buildTopology(`
[topology]
active = "debate"
`);
    const proposer = makeAgent('Proposer', 'proposer', 'one two three four', 'proposer-model');
    const skeptic = makeAgent('Skeptic', 'skeptic', 'five six seven eight nine', 'skeptic-model');

    const config = makeBaseConfig(
      topology,
      { proposer, skeptic },
      { maxRounds: 1, synthesizer: makeSynth(0.3, 'ten eleven twelve') },
    );

    const engine = new DeliberationEngine();
    const result = await engine.runTopology('metadata topic', config);

    // We expect Proposer + Skeptic + Synthesizer = 3 turns in one round.
    expect(result.turns).toHaveLength(3);
    for (const turn of result.turns) {
      expect(turn.model).toBeTruthy();
      expect(turn.neurotype).toBeTruthy();
      expect(turn.word_count).toBeTypeOf('number');
      expect(turn.word_count).toBeGreaterThan(0);
    }

    const proposerTurn = result.turns.find((t) => t.agent === 'Proposer')!;
    expect(proposerTurn.model).toBe('proposer-model');
    expect(proposerTurn.neurotype).toBe('proposer');
    expect(proposerTurn.word_count).toBe(4); // "one two three four"

    const skepticTurn = result.turns.find((t) => t.agent === 'Skeptic')!;
    expect(skepticTurn.word_count).toBe(5);

    const synthTurn = result.turns.find((t) => t.agent === 'Synthesizer')!;
    expect(synthTurn.word_count).toBe(3);
  });

  it('records word_count = 0 for an empty content string (boundary case)', async () => {
    // Defensive: an agent that returns empty content (e.g. cap-truncated to
    // nothing) MUST still get a word_count populated (zero), not undefined.
    const topology = buildTopology(`
[topology]
active = "debate"
`);
    const proposer = makeAgent('Proposer', 'proposer', '');
    const skeptic = makeAgent('Skeptic', 'skeptic', 'has words');

    const config = makeBaseConfig(topology, { proposer, skeptic }, { maxRounds: 1 });

    const engine = new DeliberationEngine();
    const result = await engine.runTopology('empty content topic', config);

    const proposerTurn = result.turns.find((t) => t.agent === 'Proposer')!;
    expect(proposerTurn.word_count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AC4 — optional:true parsed but not evaluated for skip
// ---------------------------------------------------------------------------

describe('runTopology — AC4 (optional parsed, not skipped)', () => {
  it('logs optional=true at engine start and runs the step anyway', async () => {
    const topology = buildTopology(`
[topology]
active = "with-optional"

[topology.presets.with-optional]
name = "With Optional"
description = "Has an opt-in skippable step."
best_for = "Stage 1 optional-flag plumbing."
steps = [
  { id = "proposer", neurotype = "proposer" },
  { id = "skeptic", neurotype = "skeptic", optional = true },
]
`);
    const proposer = makeAgent('Proposer', 'proposer', 'p');
    const skeptic = makeAgent('Skeptic', 'skeptic', 's');

    const logger: TopologyRuntimeLogger = { info: vi.fn() };

    const config = makeBaseConfig(
      topology,
      { proposer, skeptic },
      { maxRounds: 2, logger },
    );

    const engine = new DeliberationEngine();
    await engine.runTopology('optional topic', config);

    // The optional-flagged step MUST run every round despite the flag —
    // skip semantics are deferred to a later stage.
    expect((skeptic.generate as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(2);

    // The runtime logs the optional flag exactly once (engine start), not
    // per-round, so the log volume stays sane on long runs.
    expect((logger.info as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    const message = (logger.info as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(message).toMatch(/skeptic/);
    expect(message).toMatch(/optional=true/);
    expect(message).toMatch(/Stage 1 runs it anyway/);
  });

  it('does not log when no step is optional', async () => {
    const topology = buildTopology(`
[topology]
active = "debate"
`);
    const proposer = makeAgent('Proposer', 'proposer', 'p');
    const skeptic = makeAgent('Skeptic', 'skeptic', 's');

    const logger: TopologyRuntimeLogger = { info: vi.fn() };

    const config = makeBaseConfig(
      topology,
      { proposer, skeptic },
      { maxRounds: 1, logger },
    );

    const engine = new DeliberationEngine();
    await engine.runTopology('no-optional topic', config);

    expect((logger.info as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Smoke test: RedAgent injection still works in topology mode
// ---------------------------------------------------------------------------

describe('runTopology — RedAgent infrastructure', () => {
  it('injects RedAgent at redAgentInterval (out-of-band, like Sentry)', async () => {
    const topology = buildTopology(`
[topology]
active = "debate"
`);
    const proposer = makeAgent('Proposer', 'proposer', 'p');
    const skeptic = makeAgent('Skeptic', 'skeptic', 's');
    const redAgent = makeAgent('RedAgent', 'disruptive', 'red disruption');

    const config = makeBaseConfig(
      topology,
      { proposer, skeptic },
      { maxRounds: 4, redAgentInterval: 2, redAgent },
    );

    const engine = new DeliberationEngine();
    const result = await engine.runTopology('red-agent topic', config);

    // RedAgent fires on rounds 2 and 4.
    expect((redAgent.generate as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(2);

    const redTurns = result.turns.filter((t) => t.agent === 'RedAgent');
    expect(redTurns.map((t) => t.round)).toEqual([2, 4]);
  });
});
