/**
 * Jury end-to-end integration test (task 0ec0c6c7).
 *
 * Runs a real Jury deliberation against a stub `ModelAdapter` so the test
 * exercises:
 *   - The fully-resolved `BUILTIN_PRESETS.jury` topology.
 *   - The real concrete agent classes (ProposerAgent, SkepticAgent,
 *     EmpiricistAgent, SteelmannerAgent, DevilsAdvocateAgent, SynthesizerAgent,
 *     SentryAgent, RedAgent) — NOT mocks.
 *   - `DeliberationEngine.runTopology` with `parallelBlockTimeoutMs` plumbed
 *     through.
 *
 * No real model backend is touched: the stub adapter returns deterministic
 * canned text per modelName, and we capture every prompt the engine sends
 * the adapter so the test can assert per-critic snapshot isolation and the
 * synthesizer's full-context view.
 */

import { describe, it, expect, vi } from 'vitest';
import type { ModelAdapter } from '../adapters/base.js';
import { ProposerAgent } from '../agents/proposer.js';
import { SkepticAgent } from '../agents/skeptic.js';
import { EmpiricistAgent } from '../agents/empiricist.js';
import { SteelmannerAgent } from '../agents/steelmanner.js';
import { DevilsAdvocateAgent } from '../agents/devils-advocate.js';
import { SynthesizerAgent } from '../agents/synthesizer.js';
import { SentryAgent } from '../agents/sentry.js';
import { RedAgent } from '../agents/red-agent.js';
import { DeliberationEngine } from '../engine.js';
import type { NeurotypeResolver } from '../engine.js';
import {
  loadTopology,
  BUILTIN_PRESETS,
  ParallelBlockTimeoutError,
} from '../topology/index.js';
import type { TopologyStep } from '../topology/index.js';
import { parse } from 'smol-toml';

// ---------------------------------------------------------------------------
// Stub adapter — captures prompts, returns deterministic text per model name.
// ---------------------------------------------------------------------------

interface CapturedCall {
  prompt: string;
  system: string | undefined;
  modelName: string;
}

function makeStubAdapter(opts: {
  modelName: string;
  /** Canned output for non-synthesizer models. */
  text: string;
  /** Captured calls accumulator (shared across all stubs in a test). */
  capture: CapturedCall[];
  /** Optional artificial delay to control completion order. */
  delayMs?: number;
}): ModelAdapter {
  return {
    modelName: opts.modelName,
    async generate(prompt: string, system?: string): Promise<string> {
      opts.capture.push({ prompt, system, modelName: opts.modelName });
      if (opts.delayMs !== undefined && opts.delayMs > 0) {
        await new Promise((r) => setTimeout(r, opts.delayMs));
      }
      return opts.text;
    },
  };
}

/**
 * Synthesizer needs a strict-JSON response to trigger the consensus path.
 * We make it return low-confidence non-consensus so the engine runs to
 * `max_rounds` after exactly one round (cleanest for the test).
 */
function makeSynthStubAdapter(capture: CapturedCall[]): ModelAdapter {
  return {
    modelName: 'stub-synth',
    async generate(prompt: string, system?: string): Promise<string> {
      capture.push({ prompt, system, modelName: 'stub-synth' });
      return JSON.stringify({
        summary: 'Synth saw the room.',
        confidence: 0.3,
        consensus: false,
        agreed: [],
        unresolved: [],
      });
    },
  };
}

/**
 * Sentry uses its own structured classifier. We stub the underlying generate
 * to return the literal token Sentry expects for the `ok` signal.
 */
function makeSentryStubAdapter(): ModelAdapter {
  return {
    modelName: 'stub-sentry',
    async generate(): Promise<string> {
      return 'ok';
    },
  };
}

// ---------------------------------------------------------------------------
// Topology + resolver wiring
// ---------------------------------------------------------------------------

function buildJuryTopology() {
  return loadTopology(parse(`
[topology]
active = "jury"
`));
}

interface AgentBundle {
  proposer: ProposerAgent;
  skeptic: SkepticAgent;
  empiricist: EmpiricistAgent;
  steelmanner: SteelmannerAgent;
  devilsAdvocate: DevilsAdvocateAgent;
  synthesizer: SynthesizerAgent;
  sentry: SentryAgent;
  redAgent: RedAgent;
  capture: CapturedCall[];
  /** Per-step model name (used by tests to attribute captured prompts). */
  modelOf: Readonly<Record<string, string>>;
}

function buildAgentBundle(opts?: {
  /** Per-step delay overrides (ms) keyed by neurotype ID. */
  delays?: Partial<Record<string, number>>;
}): AgentBundle {
  const capture: CapturedCall[] = [];
  const delays = opts?.delays ?? {};

  const proposerAdapter = makeStubAdapter({
    modelName: 'stub-proposer',
    text: 'Proposer says X is true.',
    capture,
    ...(delays['proposer'] !== undefined ? { delayMs: delays['proposer'] } : {}),
  });
  const skepticAdapter = makeStubAdapter({
    modelName: 'stub-skeptic',
    text: 'Skeptic doubts X.',
    capture,
    ...(delays['skeptic'] !== undefined ? { delayMs: delays['skeptic'] } : {}),
  });
  const empiricistAdapter = makeStubAdapter({
    modelName: 'stub-empiricist',
    text: 'Empiricist demands evidence for X.',
    capture,
    ...(delays['empiricist'] !== undefined ? { delayMs: delays['empiricist'] } : {}),
  });
  const steelmannerAdapter = makeStubAdapter({
    modelName: 'stub-steelmanner',
    text: 'Steelmanner restates X charitably.',
    capture,
    ...(delays['steelmanner'] !== undefined ? { delayMs: delays['steelmanner'] } : {}),
  });
  const devilsAdapter = makeStubAdapter({
    modelName: 'stub-devil',
    text: 'Devil opposes X.',
    capture,
    ...(delays['devils-advocate'] !== undefined ? { delayMs: delays['devils-advocate'] } : {}),
  });
  const redAdapter = makeStubAdapter({
    modelName: 'stub-red',
    text: 'Red disrupts.',
    capture,
  });
  const synthAdapter = makeSynthStubAdapter(capture);
  const sentryAdapter = makeSentryStubAdapter();

  return {
    proposer: new ProposerAgent(proposerAdapter),
    skeptic: new SkepticAgent(skepticAdapter),
    empiricist: new EmpiricistAgent(empiricistAdapter),
    steelmanner: new SteelmannerAgent(steelmannerAdapter),
    devilsAdvocate: new DevilsAdvocateAgent(devilsAdapter),
    synthesizer: new SynthesizerAgent(synthAdapter),
    sentry: new SentryAgent(sentryAdapter),
    redAgent: new RedAgent(redAdapter),
    capture,
    modelOf: {
      proposer: 'stub-proposer',
      skeptic: 'stub-skeptic',
      empiricist: 'stub-empiricist',
      steelmanner: 'stub-steelmanner',
      'devils-advocate': 'stub-devil',
    },
  };
}

function makeResolver(bundle: AgentBundle): NeurotypeResolver {
  return (step: TopologyStep) => {
    switch (step.neurotype) {
      case 'proposer':
        return bundle.proposer;
      case 'skeptic':
        return bundle.skeptic;
      case 'empiricist':
        return bundle.empiricist;
      case 'steelmanner':
        return bundle.steelmanner;
      case 'devils-advocate':
        return bundle.devilsAdvocate;
      default:
        throw new Error(`unexpected neurotype "${step.neurotype}"`);
    }
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Jury preset — end-to-end integration (task 0ec0c6c7)', () => {
  it('AC1: each critic\'s prompt contains the Proposer turn but NOT the other critics\' turns', async () => {
    const bundle = buildAgentBundle();
    const topology = buildJuryTopology();

    const engine = new DeliberationEngine();
    const result = await engine.runTopology('Is X true?', {
      maxRounds: 1,
      redAgentInterval: 99,
      confidenceThreshold: 0.7,
      topology,
      resolveNeurotype: makeResolver(bundle),
      synthesizer: bundle.synthesizer,
      redAgent: bundle.redAgent,
      sentry: bundle.sentry,
    });

    expect(result.terminationReason).toBe('max_rounds');

    // The four critics each produced exactly one prompt via their own
    // adapter. Build a per-critic prompt index from the capture log.
    const critics = ['skeptic', 'empiricist', 'steelmanner', 'devils-advocate'];
    const criticPrompts: Record<string, string> = {};
    for (const id of critics) {
      const stubModel = bundle.modelOf[id]!;
      const calls = bundle.capture.filter((c) => c.modelName === stubModel);
      expect(calls).toHaveLength(1);
      criticPrompts[id] = calls[0]!.prompt;
    }

    // Each critic's prompt must mention the Proposer turn — using SkepticAgent's
    // formatter convention `[Proposer]: ...`.
    for (const id of critics) {
      expect(criticPrompts[id]).toContain('[Proposer]:');
      expect(criticPrompts[id]).toContain('Proposer says X is true.');
    }

    // No critic's prompt may contain ANY other critic's content. We probe
    // each critic's prompt against the canned text of every OTHER critic.
    const cannedFor: Record<string, string> = {
      skeptic: 'Skeptic doubts X.',
      empiricist: 'Empiricist demands evidence for X.',
      steelmanner: 'Steelmanner restates X charitably.',
      'devils-advocate': 'Devil opposes X.',
    };
    for (const id of critics) {
      for (const other of critics) {
        if (other === id) continue;
        expect(
          criticPrompts[id],
          `${id}'s prompt unexpectedly contained ${other}'s output`,
        ).not.toContain(cannedFor[other]!);
      }
    }
  });

  it('AC2: all four critic turns share the same parallel_group UUID', async () => {
    const bundle = buildAgentBundle();
    const topology = buildJuryTopology();

    const engine = new DeliberationEngine();
    const result = await engine.runTopology('jury topic', {
      maxRounds: 1,
      redAgentInterval: 99,
      confidenceThreshold: 0.7,
      topology,
      resolveNeurotype: makeResolver(bundle),
      synthesizer: bundle.synthesizer,
      redAgent: bundle.redAgent,
      sentry: bundle.sentry,
    });

    const criticTurns = result.turns.filter((t) =>
      ['Skeptic', 'Empiricist', 'Steelmanner', 'DevilsAdvocate'].includes(t.agent),
    );
    expect(criticTurns).toHaveLength(4);
    const groups = criticTurns.map((t) => t.parallel_group);
    expect(new Set(groups).size).toBe(1);
    expect(groups[0]).toBeTruthy();

    // Sequential turns (Proposer + Synthesizer) must NOT carry parallel_group.
    const sequentialTurns = result.turns.filter(
      (t) => t.agent === 'Proposer' || t.agent === 'Synthesizer',
    );
    for (const t of sequentialTurns) {
      expect(t.parallel_group ?? null).toBeNull();
    }
  });

  it('AC3: synthesizer\'s prompt context includes Proposer + all 4 critic turns', async () => {
    const bundle = buildAgentBundle();
    const topology = buildJuryTopology();

    const engine = new DeliberationEngine();
    await engine.runTopology('synth-context topic', {
      maxRounds: 1,
      redAgentInterval: 99,
      confidenceThreshold: 0.7,
      topology,
      resolveNeurotype: makeResolver(bundle),
      synthesizer: bundle.synthesizer,
      redAgent: bundle.redAgent,
      sentry: bundle.sentry,
    });

    const synthCalls = bundle.capture.filter((c) => c.modelName === 'stub-synth');
    expect(synthCalls).toHaveLength(1);
    const synthPrompt = synthCalls[0]!.prompt;

    expect(synthPrompt).toContain('[Proposer]:');
    expect(synthPrompt).toContain('Proposer says X is true.');
    expect(synthPrompt).toContain('[Skeptic]:');
    expect(synthPrompt).toContain('Skeptic doubts X.');
    expect(synthPrompt).toContain('[Empiricist]:');
    expect(synthPrompt).toContain('Empiricist demands evidence for X.');
    expect(synthPrompt).toContain('[Steelmanner]:');
    expect(synthPrompt).toContain('Steelmanner restates X charitably.');
    expect(synthPrompt).toContain('[DevilsAdvocate]:');
    expect(synthPrompt).toContain('Devil opposes X.');
  });

  it('AC4: critic turns appear in registration order regardless of completion order', async () => {
    // Reverse-shuffle delays so the LAST-registered critic finishes first
    // and the FIRST-registered finishes last.
    const bundle = buildAgentBundle({
      delays: {
        skeptic: 30, // declared first → slowest
        empiricist: 20,
        steelmanner: 10,
        'devils-advocate': 0, // declared last → fastest
      },
    });
    const topology = buildJuryTopology();

    const engine = new DeliberationEngine();
    const result = await engine.runTopology('order topic', {
      maxRounds: 1,
      redAgentInterval: 99,
      confidenceThreshold: 0.7,
      topology,
      resolveNeurotype: makeResolver(bundle),
      synthesizer: bundle.synthesizer,
      redAgent: bundle.redAgent,
      sentry: bundle.sentry,
    });

    const criticTurnAgents = result.turns
      .filter((t) =>
        ['Skeptic', 'Empiricist', 'Steelmanner', 'DevilsAdvocate'].includes(t.agent),
      )
      .map((t) => t.agent);

    // Skeptic finished LAST in real time but appears FIRST in transcript.
    expect(criticTurnAgents).toEqual([
      'Skeptic',
      'Empiricist',
      'Steelmanner',
      'DevilsAdvocate',
    ]);
  });

  it('AC5: block timeout aborts the deliberation with the slow critic named in the error', async () => {
    // Make Steelmanner exceed the timeout. The block timeout fires; the
    // engine must propagate ParallelBlockTimeoutError up the stack.
    const bundle = buildAgentBundle({ delays: { steelmanner: 200 } });
    const topology = buildJuryTopology();

    const engine = new DeliberationEngine();
    const promise = engine.runTopology('timeout topic', {
      maxRounds: 1,
      redAgentInterval: 99,
      confidenceThreshold: 0.7,
      topology,
      resolveNeurotype: makeResolver(bundle),
      synthesizer: bundle.synthesizer,
      redAgent: bundle.redAgent,
      sentry: bundle.sentry,
      parallelBlockTimeoutMs: 50,
    });

    await expect(promise).rejects.toBeInstanceOf(ParallelBlockTimeoutError);
    await expect(promise).rejects.toThrow(/"steelmanner"/);
  });

  it('AC6: the test runs without a real model backend (stub-only sanity check)', async () => {
    // Defensive smoke check — no fetch call goes out. We assert on the
    // captured-prompts log, which is the only side-effect the stubs make.
    const fetchSpy = vi.spyOn(globalThis, 'fetch' as never);
    const bundle = buildAgentBundle();
    const topology = buildJuryTopology();

    const engine = new DeliberationEngine();
    await engine.runTopology('stub-only topic', {
      maxRounds: 1,
      redAgentInterval: 99,
      confidenceThreshold: 0.7,
      topology,
      resolveNeurotype: makeResolver(bundle),
      synthesizer: bundle.synthesizer,
      redAgent: bundle.redAgent,
      sentry: bundle.sentry,
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();

    // Capture log SHOULD include the seven calls (proposer, 4 critics,
    // synthesizer, sentry runs out-of-band but uses its own adapter that
    // we don't capture for) — not a hard count assertion, just a sanity
    // check that the deliberation actually ran.
    expect(bundle.capture.length).toBeGreaterThanOrEqual(6);

    // The Jury preset is a built-in — verify the bundle saw the right
    // preset by spot-checking the registry.
    expect(BUILTIN_PRESETS['jury']).toBeDefined();
  });
});
