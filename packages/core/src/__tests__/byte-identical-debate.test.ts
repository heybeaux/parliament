import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'smol-toml';
import type { Agent, AgentResult } from '../agents/base.js';
import type { SynthesizerAgent, SynthesizerResult } from '../agents/synthesizer.js';
import type { SentryAgent, SentryResult } from '../agents/sentry.js';
import type { Turn, SynthesizerMeta } from '../types.js';
import { DeliberationEngine } from '../engine.js';
import type {
  DeliberationConfig,
  TopologyDeliberationConfig,
} from '../engine.js';
import { loadTopology, type TopologyStep } from '../topology/index.js';

/**
 * ----------------------------------------------------------------------------
 * Byte-identical Debate transcript regression test (Stage 1 / topology-runtime)
 * ----------------------------------------------------------------------------
 *
 * What this pins: `DeliberationEngine.runTopology()` invoked with
 * `[topology].active = "debate"` MUST produce a `Turn[]` byte-identical
 * (after timestamp normalization) to `DeliberationEngine.run()` — the
 * legacy hardcoded five-agent pipeline that is the canonical pre-refactor
 * Debate implementation.
 *
 * Scope is **transcript only** per the Stage 1 elaboration decision:
 *   - Turn[] content, ordering, per-turn metadata (agent, neurotype, model,
 *     word_count, round, meta) — load-bearing.
 *   - Timestamps — normalized to a fixed sentinel before compare.
 *   - Logs, sentry signal counts, internal accumulators, blackboard.metadata,
 *     residue scoring — explicitly OUT of scope.
 *
 * Two layers of assertion:
 *   1. Cross-engine equality: `run()` and `runTopology(active=debate)`
 *      produce the same normalized Turn[] when fed the same deterministic
 *      stubs. This is the load-bearing regression contract.
 *   2. Fixture equality: both also match the JSON golden in
 *      `fixtures/debate-golden.json`. The fixture records the originating
 *      commit hash so a future engineer can locate the canonical
 *      pre-refactor pipeline if they need to re-derive the contract.
 *
 * Backend: deterministic stubs only — the test runs in CI without any model
 * adapter, server, or external service.
 * ----------------------------------------------------------------------------
 */

// ---------------------------------------------------------------------------
// Deterministic stub factories
// ---------------------------------------------------------------------------

/**
 * Stable per-turn content and metadata. The fixture's content strings come
 * from these constants — keep them in sync if you ever regenerate the
 * fixture. We deliberately use realistic prose (rather than 'foo'/'bar') so
 * a regression in word_count or whitespace handling shows up.
 */
const PROPOSER_CONTENT =
  'Adopt feature flags universally because they decouple deploy from release.';
const SKEPTIC_CONTENT =
  'Universal flags add operational tax; not every endpoint needs runtime gating.';
const SYNTH_CONTENT =
  'Adopt flags for risky endpoints; let trivial CRUD ship without the overhead.';
const SYNTH_META: SynthesizerMeta = {
  confidence: 0.5,
  consensus: false,
  agreed: ['flags help risky rollouts'],
  unresolved: ['scope: every endpoint vs subset'],
};

const PROPOSER_NEUROTYPE = 'structured';
const SKEPTIC_NEUROTYPE = 'critical';
const SYNTH_NEUROTYPE = 'integrative';

const PROPOSER_MODEL = 'stub-proposer';
const SKEPTIC_MODEL = 'stub-skeptic';
const SYNTH_MODEL = 'stub-synthesizer';

const TOPIC = 'Should the team adopt feature flags for every new endpoint?';

function makeAgent(
  role: string,
  neurotype: string,
  modelName: string,
  content: string,
): Agent {
  return {
    role,
    neurotype,
    modelName,
    generate: vi.fn().mockResolvedValue({
      content,
      truncated: false,
    } satisfies AgentResult),
  };
}

function makeSynth(
  content: string,
  meta: SynthesizerMeta,
): SynthesizerAgent {
  return {
    role: 'Synthesizer',
    neurotype: SYNTH_NEUROTYPE,
    modelName: SYNTH_MODEL,
    generate: vi.fn().mockResolvedValue({
      content,
      truncated: false,
      confidence: meta.confidence,
      meta,
    } satisfies SynthesizerResult),
  } as unknown as SynthesizerAgent;
}

function makeSentry(): SentryAgent {
  return {
    role: 'Sentry',
    neurotype: 'monitoring',
    modelName: 'stub-sentry',
    generate: vi.fn().mockResolvedValue({
      signal: 'ok',
      reason: 'stub',
    } satisfies SentryResult),
  } as unknown as SentryAgent;
}

// ---------------------------------------------------------------------------
// Engine config builders — both paths use the SAME stub instances, drawn
// from the same factories with the same content. That's how we make the
// transcript byte-identical: nothing about the runtime should change the
// per-turn output if it goes through `recordTurn` faithfully.
// ---------------------------------------------------------------------------

function buildLegacyConfig(): {
  config: DeliberationConfig;
  proposer: Agent;
  skeptic: Agent;
  synth: SynthesizerAgent;
} {
  const proposer = makeAgent(
    'Proposer',
    PROPOSER_NEUROTYPE,
    PROPOSER_MODEL,
    PROPOSER_CONTENT,
  );
  const skeptic = makeAgent('Skeptic', SKEPTIC_NEUROTYPE, SKEPTIC_MODEL, SKEPTIC_CONTENT);
  const synth = makeSynth(SYNTH_CONTENT, SYNTH_META);
  const redAgent = makeAgent('RedAgent', 'disruptive', 'stub-red', 'red content');
  const sentry = makeSentry();
  return {
    config: {
      maxRounds: 2,
      // Set redAgentInterval > maxRounds so RedAgent never fires. The fixture
      // pins the no-RedAgent path for clarity; a separate test could cover
      // RedAgent injection.
      redAgentInterval: 99,
      confidenceThreshold: 0.7,
      agents: { proposer, skeptic, synthesizer: synth, redAgent, sentry },
    },
    proposer,
    skeptic,
    synth,
  };
}

function buildTopologyConfig(deps: {
  proposer: Agent;
  skeptic: Agent;
  synth: SynthesizerAgent;
}): TopologyDeliberationConfig {
  // Use the real loader so we exercise the same path the production runtime
  // walks. Built-in `debate` resolves without any user-defined config.
  const topology = loadTopology(parse(`
[topology]
active = "debate"
`));

  // Resolver returns the SAME stub instances passed in. The two stubs are
  // shared across legacy and topology runs — call counts will diverge between
  // paths (e.g. sentry fires more times in the step phase under topology),
  // but the transcript is unaffected because sentry never records turns.
  const resolveNeurotype = (step: TopologyStep): Agent => {
    if (step.neurotype === 'proposer') return deps.proposer;
    if (step.neurotype === 'skeptic') return deps.skeptic;
    throw new Error(`unexpected neurotype in debate preset: ${step.neurotype}`);
  };

  return {
    maxRounds: 2,
    redAgentInterval: 99,
    confidenceThreshold: 0.7,
    topology,
    resolveNeurotype,
    synthesizer: deps.synth,
    redAgent: makeAgent('RedAgent', 'disruptive', 'stub-red', 'red content'),
    sentry: makeSentry(),
  };
}

// ---------------------------------------------------------------------------
// Normalization — the only field allowed to differ between runs.
// ---------------------------------------------------------------------------

const NORMALIZED_TS = 'NORMALIZED';

function normalizeTurns(turns: readonly Turn[]): Turn[] {
  return turns.map((t) => ({ ...t, timestamp: NORMALIZED_TS }));
}

// ---------------------------------------------------------------------------
// Fixture loader
// ---------------------------------------------------------------------------

interface DebateGoldenFixture {
  _metadata: {
    purpose: string;
    scope: string;
    originating_commit: string;
    originating_branch: string;
    captured_via: string;
    normalization: string[];
    what_this_pins: string;
  };
  topic: string;
  turns: Turn[];
}

function loadFixture(): DebateGoldenFixture {
  const here = fileURLToPath(import.meta.url);
  const path = resolve(here, '..', 'fixtures', 'debate-golden.json');
  const raw = readFileSync(path, 'utf-8');
  return JSON.parse(raw) as DebateGoldenFixture;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Debate preset: byte-identical transcript across legacy vs topology', () => {
  it('legacy run() produces the canonical Turn[] recorded in the golden fixture', async () => {
    const { config } = buildLegacyConfig();
    const engine = new DeliberationEngine();
    const result = await engine.run(TOPIC, config);

    const fixture = loadFixture();
    expect(result.topic).toBe(fixture.topic);
    expect(normalizeTurns(result.turns)).toEqual(fixture.turns);
  });

  it('runTopology(active=debate) produces the SAME Turn[] as legacy run()', async () => {
    const legacy = buildLegacyConfig();
    const engine = new DeliberationEngine();
    const legacyResult = await engine.run(TOPIC, legacy.config);

    // Build a fresh topology config that shares NO stub instances with the
    // legacy run — that would be a confound (vi.fn() spies persist call
    // counts across calls). Independent stubs, same content.
    const fresh = buildLegacyConfig();
    const topologyConfig = buildTopologyConfig({
      proposer: fresh.proposer,
      skeptic: fresh.skeptic,
      synth: fresh.synth,
    });
    const topologyResult = await engine.runTopology(TOPIC, topologyConfig);

    expect(topologyResult.topic).toBe(legacyResult.topic);
    expect(normalizeTurns(topologyResult.turns)).toEqual(
      normalizeTurns(legacyResult.turns),
    );
  });

  it('runTopology(active=debate) matches the golden fixture directly', async () => {
    const { proposer, skeptic, synth } = buildLegacyConfig();
    const topologyConfig = buildTopologyConfig({ proposer, skeptic, synth });

    const engine = new DeliberationEngine();
    const result = await engine.runTopology(TOPIC, topologyConfig);

    const fixture = loadFixture();
    expect(result.topic).toBe(fixture.topic);
    expect(normalizeTurns(result.turns)).toEqual(fixture.turns);
  });

  it('Proposer fires exactly once across the deliberation (round-1-only invariant)', async () => {
    const { proposer, skeptic, synth } = buildLegacyConfig();
    const topologyConfig = buildTopologyConfig({ proposer, skeptic, synth });

    const engine = new DeliberationEngine();
    await engine.runTopology(TOPIC, topologyConfig);

    expect(proposer.generate).toHaveBeenCalledTimes(1);
  });

  it('fixture metadata records the originating commit so future debugging can reconstruct context', () => {
    const fixture = loadFixture();
    // The provenance fields are part of the contract — if anyone updates the
    // fixture content without updating these, we want the test to flag it.
    expect(fixture._metadata.originating_commit).toMatch(/^[0-9a-f]{40}$/);
    expect(fixture._metadata.scope).toMatch(/[Tt]ranscript only/);
    expect(fixture._metadata.normalization).toContain(
      "timestamp -> 'NORMALIZED'",
    );
  });
});
