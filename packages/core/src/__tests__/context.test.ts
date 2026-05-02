/**
 * PAR-16 — engine context wiring.
 *
 * Verifies that when a deliberation is started with a free-form
 * `context` field, the engine:
 *
 *   1. Writes the trimmed context onto the blackboard so every agent's
 *      `generate(blackboard)` call sees the same brief.
 *   2. Routes that context through `buildPromptHeader` — used by every
 *      non-Sentry built-in agent — so each agent's user-message prompt
 *      starts with the stable `## Background` heading.
 *   3. Echoes the context back unchanged on the `DeliberationResult`.
 *
 * Sentry is intentionally outside the contract (it never calls a model
 * with prose) and is exercised by the existing OSI / sentry tests.
 *
 * No real model is needed — we drive every adapter via `vi.fn()` and
 * inspect the captured `userPrompt` argument.
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
  CONTEXT_HEADING,
  buildPromptHeader,
} from '../index.js';
import type {
  NeurotypeResolver,
  TopologyDeliberationConfig,
} from '../engine.js';
import { loadTopology } from '../topology/index.js';
import type { TopologyConfig, TopologyStep } from '../topology/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface RecordingAdapter extends ModelAdapter {
  generate: ReturnType<typeof vi.fn>;
}

/**
 * Build a deterministic adapter that captures every (userPrompt, systemPrompt)
 * tuple it sees. The synthesizer needs valid JSON so its parse/retry path
 * does not loop; everything else can return short prose.
 */
function makeAdapter(role: string, response: string, modelName = `mock-${role}`): RecordingAdapter {
  return {
    modelName,
    generate: vi.fn(async () => ({ content: response })),
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

// ---------------------------------------------------------------------------
// Pure utility: buildPromptHeader contract
// ---------------------------------------------------------------------------

describe('buildPromptHeader (PAR-16)', () => {
  it('omits the Background block when no context is supplied', () => {
    const header = buildPromptHeader('Topic A');
    expect(header).not.toContain(CONTEXT_HEADING);
    expect(header).toContain('Topic: Topic A');
  });

  it('omits the Background block for whitespace-only context', () => {
    const header = buildPromptHeader('Topic A', '   \n\t  ');
    expect(header).not.toContain(CONTEXT_HEADING);
  });

  it('prepends "## Background" + trimmed context + delimiter when present', () => {
    const header = buildPromptHeader('Topic A', '  System X uses pattern Y.  ');

    // Heading first.
    expect(header.startsWith(`${CONTEXT_HEADING}\n\nSystem X uses pattern Y.`)).toBe(true);
    // Stable delimiter separates context from the topic block.
    expect(header).toContain('\n\n---\n\n');
    // Topic line still present after the delimiter.
    expect(header).toContain('Topic: Topic A');
    // Trimmed — original outer whitespace is gone.
    expect(header).not.toContain('  System X');
  });
});

// ---------------------------------------------------------------------------
// Engine: legacy run() path
// ---------------------------------------------------------------------------

describe('DeliberationEngine.run (PAR-16 context)', () => {
  it('prepends context to every non-Sentry agent prompt and echoes it on the result', async () => {
    const proposerAdapter = makeAdapter('proposer', 'Proposer prose.');
    const skepticAdapter = makeAdapter('skeptic', 'Skeptic prose.');
    const synthesizerAdapter = makeAdapter('synthesizer', SYNTH_CONSENSUS_JSON);
    const redAdapter = makeAdapter('redAgent', 'RedAgent prose.');
    const sentryAdapter = makeAdapter('sentry', 'unused');

    const engine = new DeliberationEngine();
    const context = 'Endeavour is a single-model reasoning pipeline; integration target.';
    const result = await engine.run('Should Endeavour integrate Parliament?', {
      maxRounds: 1,
      redAgentInterval: 99,
      confidenceThreshold: 0.7,
      context,
      agents: {
        proposer: new ProposerAgent(proposerAdapter),
        skeptic: new SkepticAgent(skepticAdapter),
        synthesizer: new SynthesizerAgent(synthesizerAdapter),
        redAgent: new RedAgent(redAdapter),
        sentry: new SentryAgent(sentryAdapter),
      },
    });

    // Result echo.
    expect(result.context).toBe(context);

    // Every prose-producing adapter's userPrompt must contain the heading
    // and the context body, in that order.
    const proseAdapters: RecordingAdapter[] = [
      proposerAdapter,
      skepticAdapter,
      synthesizerAdapter,
    ];
    for (const adapter of proseAdapters) {
      expect(adapter.generate).toHaveBeenCalled();
      for (const call of adapter.generate.mock.calls) {
        const userPrompt = call[0] as string;
        expect(userPrompt.startsWith(`${CONTEXT_HEADING}\n\n`)).toBe(true);
        expect(userPrompt).toContain(context);
        expect(userPrompt).toContain('Topic: Should Endeavour integrate Parliament?');
        // The heading appears exactly once per prompt — no double-prepend.
        const headingHits = userPrompt.split(CONTEXT_HEADING).length - 1;
        expect(headingHits).toBe(1);
      }
    }

    // Sentry's adapter is intentionally untouched — it doesn't run prose
    // generation in this configuration (turns < min for legacy fallback).
    expect(sentryAdapter.generate).not.toHaveBeenCalled();
  });

  it('omits the heading entirely when no context is supplied', async () => {
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

    expect(result.context).toBeUndefined();
    for (const adapter of [proposerAdapter, skepticAdapter, synthesizerAdapter]) {
      for (const call of adapter.generate.mock.calls) {
        expect(call[0] as string).not.toContain(CONTEXT_HEADING);
      }
    }
  });

  it('treats whitespace-only context as absent', async () => {
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
      context: '   \n\t   ',
      agents: {
        proposer: new ProposerAgent(proposerAdapter),
        skeptic: new SkepticAgent(skepticAdapter),
        synthesizer: new SynthesizerAgent(synthesizerAdapter),
        redAgent: new RedAgent(redAdapter),
        sentry: new SentryAgent(sentryAdapter),
      },
    });

    expect(result.context).toBeUndefined();
    for (const call of proposerAdapter.generate.mock.calls) {
      expect(call[0] as string).not.toContain(CONTEXT_HEADING);
    }
  });
});

// ---------------------------------------------------------------------------
// Engine: topology runTopology() path — the production wire
// ---------------------------------------------------------------------------

describe('DeliberationEngine.runTopology (PAR-16 context)', () => {
  it('forwards context to every step agent through the resolver', async () => {
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
    const context = 'Background: a multi-paragraph brief describing the system at hand.';
    const cfg: TopologyDeliberationConfig = {
      maxRounds: 1,
      redAgentInterval: 99,
      confidenceThreshold: 0.7,
      topology: loadDebateTopology(),
      resolveNeurotype,
      synthesizer: new SynthesizerAgent(synthesizerAdapter),
      redAgent: new RedAgent(redAdapter),
      sentry: new SentryAgent(sentryAdapter),
      context,
    };
    const result = await engine.runTopology('Topology context test', cfg);

    expect(result.context).toBe(context);

    // Each per-step agent received a userPrompt that starts with the heading.
    for (const adapter of [proposerAdapter, skepticAdapter, synthesizerAdapter]) {
      expect(adapter.generate).toHaveBeenCalled();
      for (const call of adapter.generate.mock.calls) {
        const userPrompt = call[0] as string;
        expect(userPrompt.startsWith(`${CONTEXT_HEADING}\n\n`)).toBe(true);
        expect(userPrompt).toContain(context);
      }
    }
  });
});
