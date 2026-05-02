/**
 * PAR-17 — engine sources wiring.
 *
 * Verifies that when a deliberation is started with a structured `sources[]`
 * array, the engine:
 *
 *   1. Renders each source as a `[id] (kind?) "title"\n<content>` block
 *      under a stable `## Sources` heading on every non-Sentry agent's
 *      user prompt — between the optional `## Background` block and the
 *      base header.
 *   2. Truncates each source's `content` to the configured `maxSourceWords`
 *      (default 500), appending a `... [truncated]` marker when truncation
 *      occurred.
 *   3. Appends the standing citation instruction so every agent is told
 *      to cite by `[id]`.
 *   4. Echoes `sources` back unchanged on the result (sans the per-source
 *      content cap, which is applied at engine ingest).
 *   5. Activates the Empiricist's evidence-backed claim mode by prepending
 *      one extra line to the system prompt — only when sources are
 *      present.
 *
 * No real model is needed — adapters are driven via `vi.fn()` and we
 * inspect the captured `userPrompt` / `systemPrompt` arguments.
 */

import { describe, it, expect, vi } from 'vitest';
import { parse } from 'smol-toml';
import type { ModelAdapter } from '../adapters/base.js';
import {
  DeliberationEngine,
  ProposerAgent,
  SkepticAgent,
  RedAgent,
  SynthesizerAgent,
  SentryAgent,
  SOURCES_HEADING,
  CITATION_INSTRUCTION,
  buildPromptHeader,
  buildSourcesBlock,
} from '../index.js';
import {
  EmpiricistAgent,
  EMPIRICIST_SYSTEM_PROMPT,
  EMPIRICIST_SOURCES_MODE_PREFIX,
} from '../agents/empiricist.js';
import type {
  NeurotypeResolver,
  TopologyDeliberationConfig,
} from '../engine.js';
import { loadTopology } from '../topology/index.js';
import type { TopologyConfig, TopologyStep } from '../topology/index.js';
import type { DeliberationSource } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface RecordingAdapter extends ModelAdapter {
  generate: ReturnType<typeof vi.fn>;
}

function makeAdapter(role: string, response: string, modelName = `mock-${role}`): RecordingAdapter {
  return {
    modelName,
    generate: vi.fn(async () => response),
  };
}

const SYNTH_CONSENSUS_JSON = JSON.stringify({
  summary: 'Both sides agree on the core trade-offs.',
  confidence: 0.9,
  consensus: true,
  agreed: ['shared definition'],
  unresolved: [],
});

function loadDebateTopology(): TopologyConfig {
  return loadTopology(parse(`
[topology]
active = "debate"
`));
}

const SAMPLE_SOURCES: DeliberationSource[] = [
  {
    id: 'foo-2024',
    title: 'Foo et al. 2024 — Title',
    content: 'Some prose about a real-world study comparing alpha to beta.',
    kind: 'paper',
  },
  {
    id: 'memo-internal',
    title: 'Internal launch plan',
    content: 'A short memo that we want every agent to see verbatim.',
    kind: 'memo',
  },
];

// ---------------------------------------------------------------------------
// Pure utilities: buildSourcesBlock + buildPromptHeader
// ---------------------------------------------------------------------------

describe('buildSourcesBlock (PAR-17)', () => {
  it('returns null for undefined or empty input', () => {
    expect(buildSourcesBlock(undefined)).toBeNull();
    expect(buildSourcesBlock([])).toBeNull();
  });

  it('renders one block per source with [id] prefix, kind chip, and title', () => {
    const block = buildSourcesBlock(SAMPLE_SOURCES);
    expect(block).not.toBeNull();
    const out = block!;

    expect(out.startsWith(`${SOURCES_HEADING}\n\n`)).toBe(true);
    expect(out).toContain('[foo-2024] (paper) "Foo et al. 2024 — Title"');
    expect(out).toContain('[memo-internal] (memo) "Internal launch plan"');
    expect(out).toContain('Some prose about a real-world study');
    // Citation instruction is appended exactly once.
    expect(out.endsWith(CITATION_INSTRUCTION)).toBe(true);
    expect(out.split(CITATION_INSTRUCTION).length - 1).toBe(1);
  });

  it('omits the kind chip when a source has no kind declared', () => {
    const block = buildSourcesBlock([
      { id: 'no-kind', title: 'Anonymous', content: 'body' },
    ])!;
    expect(block).toContain('[no-kind] "Anonymous"');
    // No '(...)' kind chip at all.
    expect(block).not.toMatch(/\[no-kind\] \([^)]+\) "Anonymous"/);
  });

  it('truncates per-source content to the cap with a ... [truncated] marker', () => {
    const longBody = Array.from({ length: 50 }, (_, i) => `w${i}`).join(' ');
    const block = buildSourcesBlock(
      [{ id: 's', title: 't', content: longBody }],
      4,
    )!;
    expect(block).toContain('w0 w1 w2 w3 ... [truncated]');
    expect(block).not.toContain('w4');
  });
});

describe('buildPromptHeader (PAR-17 sources composition)', () => {
  it('places the Sources block between the Background block and the base header', () => {
    const header = buildPromptHeader(
      'Topic Z',
      'Background prose.',
      SAMPLE_SOURCES,
    );
    const ctxIdx = header.indexOf('## Background');
    const srcIdx = header.indexOf(SOURCES_HEADING);
    const topicIdx = header.indexOf('Topic: Topic Z');

    expect(ctxIdx).toBeGreaterThanOrEqual(0);
    expect(srcIdx).toBeGreaterThan(ctxIdx);
    expect(topicIdx).toBeGreaterThan(srcIdx);
    // Stable section delimiter between blocks.
    expect(header).toContain('\n\n---\n\n');
  });

  it('omits the Sources block entirely when no sources are supplied', () => {
    const header = buildPromptHeader('Topic Z', undefined, undefined);
    expect(header).not.toContain(SOURCES_HEADING);
    expect(header).not.toContain(CITATION_INSTRUCTION);
  });
});

// ---------------------------------------------------------------------------
// Engine: legacy run() path
// ---------------------------------------------------------------------------

describe('DeliberationEngine.run (PAR-17 sources)', () => {
  it('renders ## Sources, the [id]-prefixed blocks, and the citation instruction on every non-Sentry agent prompt; echoes sources on the result', async () => {
    const proposerAdapter = makeAdapter('proposer', 'Proposer prose.');
    const skepticAdapter = makeAdapter('skeptic', 'Skeptic prose.');
    const synthesizerAdapter = makeAdapter('synthesizer', SYNTH_CONSENSUS_JSON);
    const redAdapter = makeAdapter('redAgent', 'RedAgent prose.');
    const sentryAdapter = makeAdapter('sentry', 'unused');

    const engine = new DeliberationEngine();
    const result = await engine.run('Topic with sources', {
      maxRounds: 1,
      redAgentInterval: 99,
      confidenceThreshold: 0.7,
      sources: SAMPLE_SOURCES,
      agents: {
        proposer: new ProposerAgent(proposerAdapter),
        skeptic: new SkepticAgent(skepticAdapter),
        synthesizer: new SynthesizerAgent(synthesizerAdapter),
        redAgent: new RedAgent(redAdapter),
        sentry: new SentryAgent(sentryAdapter),
      },
    });

    expect(result.sources).toBeDefined();
    expect(result.sources).toHaveLength(2);
    expect(result.sources![0]?.id).toBe('foo-2024');

    for (const adapter of [proposerAdapter, skepticAdapter, synthesizerAdapter]) {
      expect(adapter.generate).toHaveBeenCalled();
      for (const call of adapter.generate.mock.calls) {
        const userPrompt = call[0] as string;
        expect(userPrompt).toContain(SOURCES_HEADING);
        expect(userPrompt).toContain('[foo-2024] (paper) "Foo et al. 2024 — Title"');
        expect(userPrompt).toContain('[memo-internal] (memo) "Internal launch plan"');
        expect(userPrompt).toContain(CITATION_INSTRUCTION);
        // Heading appears exactly once per prompt — no double-prepend.
        expect(userPrompt.split(SOURCES_HEADING).length - 1).toBe(1);
      }
    }

    // Sentry is intentionally untouched.
    expect(sentryAdapter.generate).not.toHaveBeenCalled();
  });

  it('omits the heading entirely when no sources are supplied', async () => {
    const proposerAdapter = makeAdapter('proposer', 'Proposer prose.');
    const skepticAdapter = makeAdapter('skeptic', 'Skeptic prose.');
    const synthesizerAdapter = makeAdapter('synthesizer', SYNTH_CONSENSUS_JSON);
    const redAdapter = makeAdapter('redAgent', 'RedAgent prose.');
    const sentryAdapter = makeAdapter('sentry', 'unused');

    const engine = new DeliberationEngine();
    const result = await engine.run('Plain topic', {
      maxRounds: 1,
      redAgentInterval: 99,
      confidenceThreshold: 0.7,
      agents: {
        proposer: new ProposerAgent(proposerAdapter),
        skeptic: new SkepticAgent(skepticAdapter),
        synthesizer: new SynthesizerAgent(synthesizerAdapter),
        redAgent: new RedAgent(redAdapter),
        sentry: new SentryAgent(sentryAdapter),
      },
    });

    expect(result.sources).toBeUndefined();
    for (const adapter of [proposerAdapter, skepticAdapter, synthesizerAdapter]) {
      for (const call of adapter.generate.mock.calls) {
        expect(call[0] as string).not.toContain(SOURCES_HEADING);
        expect(call[0] as string).not.toContain(CITATION_INSTRUCTION);
      }
    }
  });

  it('truncates per-source content to maxSourceWords with a ... [truncated] marker', async () => {
    const proposerAdapter = makeAdapter('proposer', 'Proposer prose.');
    const skepticAdapter = makeAdapter('skeptic', 'Skeptic prose.');
    const synthesizerAdapter = makeAdapter('synthesizer', SYNTH_CONSENSUS_JSON);
    const redAdapter = makeAdapter('redAgent', 'RedAgent prose.');
    const sentryAdapter = makeAdapter('sentry', 'unused');

    const longBody = Array.from({ length: 80 }, (_, i) => `w${i}`).join(' ');
    const sources: DeliberationSource[] = [
      { id: 'long', title: 'Long doc', content: longBody, kind: 'paper' },
    ];

    const engine = new DeliberationEngine();
    const result = await engine.run('Topic with long source', {
      maxRounds: 1,
      redAgentInterval: 99,
      confidenceThreshold: 0.7,
      sources,
      maxSourceWords: 5,
      agents: {
        proposer: new ProposerAgent(proposerAdapter),
        skeptic: new SkepticAgent(skepticAdapter),
        synthesizer: new SynthesizerAgent(synthesizerAdapter),
        redAgent: new RedAgent(redAdapter),
        sentry: new SentryAgent(sentryAdapter),
      },
    });

    expect(result.sources).toBeDefined();
    expect(result.sources![0]?.content).toContain('... [truncated]');
    expect(result.sources![0]?.content).not.toContain('w50');

    for (const adapter of [proposerAdapter, skepticAdapter]) {
      const call = adapter.generate.mock.calls[0];
      expect(call).toBeDefined();
      const userPrompt = call![0] as string;
      expect(userPrompt).toContain('w0 w1 w2 w3 w4 ... [truncated]');
      expect(userPrompt).not.toContain('w5 ');
    }
  });
});

// ---------------------------------------------------------------------------
// Engine: topology runTopology() path
// ---------------------------------------------------------------------------

describe('DeliberationEngine.runTopology (PAR-17 sources)', () => {
  it('forwards sources to every step agent through the resolver and echoes them on the result', async () => {
    const proposerAdapter = makeAdapter('proposer', 'Proposer prose.');
    const skepticAdapter = makeAdapter('skeptic', 'Skeptic prose.');
    const synthesizerAdapter = makeAdapter('synthesizer', SYNTH_CONSENSUS_JSON);
    const redAdapter = makeAdapter('redAgent', 'RedAgent prose.');
    const sentryAdapter = makeAdapter('sentry', 'unused');

    const proposerAgent = new ProposerAgent(proposerAdapter);
    const skepticAgent = new SkepticAgent(skepticAdapter);

    const resolveNeurotype: NeurotypeResolver = (step: TopologyStep) => {
      if (step.id === 'proposer') return proposerAgent;
      if (step.id === 'skeptic') return skepticAgent;
      throw new Error(`unexpected step ${step.id}`);
    };

    const engine = new DeliberationEngine();
    const cfg: TopologyDeliberationConfig = {
      maxRounds: 1,
      redAgentInterval: 99,
      confidenceThreshold: 0.7,
      topology: loadDebateTopology(),
      resolveNeurotype,
      synthesizer: new SynthesizerAgent(synthesizerAdapter),
      redAgent: new RedAgent(redAdapter),
      sentry: new SentryAgent(sentryAdapter),
      sources: SAMPLE_SOURCES,
    };
    const result = await engine.runTopology('Topology sources test', cfg);

    expect(result.sources).toBeDefined();
    expect(result.sources).toHaveLength(2);

    for (const adapter of [proposerAdapter, skepticAdapter, synthesizerAdapter]) {
      expect(adapter.generate).toHaveBeenCalled();
      for (const call of adapter.generate.mock.calls) {
        const userPrompt = call[0] as string;
        expect(userPrompt).toContain(SOURCES_HEADING);
        expect(userPrompt).toContain('[foo-2024]');
        expect(userPrompt).toContain('[memo-internal]');
        expect(userPrompt).toContain(CITATION_INSTRUCTION);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Empiricist: evidence-backed claim mode
// ---------------------------------------------------------------------------

describe('EmpiricistAgent (PAR-17 evidence-backed claim mode)', () => {
  it('prepends the activation line to the system prompt when sources are present', async () => {
    const adapter = makeAdapter('empiricist', 'Empiricist prose.');
    const empiricist = new EmpiricistAgent(adapter);

    await empiricist.generate({
      topic: 'Whatever',
      turns: [],
      conflicts: [],
      metadata: {},
      sources: SAMPLE_SOURCES,
    });

    expect(adapter.generate).toHaveBeenCalledTimes(1);
    const call = adapter.generate.mock.calls[0]!;
    const systemPrompt = call[1] as string;
    expect(systemPrompt.startsWith(EMPIRICIST_SOURCES_MODE_PREFIX)).toBe(true);
    expect(systemPrompt).toContain(EMPIRICIST_SYSTEM_PROMPT);
  });

  it('uses the standing system prompt when no sources are attached', async () => {
    const adapter = makeAdapter('empiricist', 'Empiricist prose.');
    const empiricist = new EmpiricistAgent(adapter);

    await empiricist.generate({
      topic: 'Whatever',
      turns: [],
      conflicts: [],
      metadata: {},
    });

    expect(adapter.generate).toHaveBeenCalledTimes(1);
    const call = adapter.generate.mock.calls[0]!;
    const systemPrompt = call[1] as string;
    expect(systemPrompt).toBe(EMPIRICIST_SYSTEM_PROMPT);
    expect(systemPrompt).not.toContain(EMPIRICIST_SOURCES_MODE_PREFIX);
  });

  it('uses the standing system prompt when sources is an empty array', async () => {
    const adapter = makeAdapter('empiricist', 'Empiricist prose.');
    const empiricist = new EmpiricistAgent(adapter);

    await empiricist.generate({
      topic: 'Whatever',
      turns: [],
      conflicts: [],
      metadata: {},
      sources: [],
    });

    const call = adapter.generate.mock.calls[0]!;
    const systemPrompt = call[1] as string;
    expect(systemPrompt).toBe(EMPIRICIST_SYSTEM_PROMPT);
  });
});
