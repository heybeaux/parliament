/**
 * Lattice integration tests for `DeliberationEngine.runTopology`.
 *
 * Mirror the harness in `jury-integration.test.ts` (real concrete agents +
 * a stub `ModelAdapter`) but flip on `lattice.enabled` and assert:
 *
 *   1. SEQUENTIAL preset (debate): every non-structural agent call is
 *      wrapped — one audit-log line per critic per round, none for the
 *      synthesizer/sentry/redAgent. The result carries a `LatticeReport`.
 *   2. PARALLEL preset (jury): the parallel block path also threads through
 *      `latticeWrap` — one audit line per critic in the parallel group.
 *   3. `lattice.enabled === false` is a no-op: no `result.lattice`, no audit
 *      file, no synthesis appendix.
 */

import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'smol-toml';
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
import { loadTopology } from '../topology/index.js';
import type { TopologyStep } from '../topology/index.js';

function makeStubAdapter(modelName: string, text: string): ModelAdapter {
  return {
    modelName,
    async generate() {
      return { content: text };
    },
  };
}

function makeSynthStub(): ModelAdapter {
  return {
    modelName: 'stub-synth',
    async generate() {
      return {
        content: JSON.stringify({
          summary: 'Synth saw the room.',
          confidence: 0.3,
          consensus: false,
          agreed: [],
          unresolved: [],
        }),
      };
    },
  };
}

function makeSentryStub(): ModelAdapter {
  return {
    modelName: 'stub-sentry',
    async generate() {
      return { content: 'ok' };
    },
  };
}

function buildAgents(): {
  proposer: ProposerAgent;
  skeptic: SkepticAgent;
  empiricist: EmpiricistAgent;
  steelmanner: SteelmannerAgent;
  devilsAdvocate: DevilsAdvocateAgent;
  synthesizer: SynthesizerAgent;
  redAgent: RedAgent;
  sentry: SentryAgent;
} {
  return {
    proposer: new ProposerAgent(makeStubAdapter('stub-proposer', 'Proposer text.')),
    skeptic: new SkepticAgent(makeStubAdapter('stub-skeptic', 'Skeptic text.')),
    empiricist: new EmpiricistAgent(makeStubAdapter('stub-empiricist', 'Empiricist text.')),
    steelmanner: new SteelmannerAgent(makeStubAdapter('stub-steelmanner', 'Steelmanner text.')),
    devilsAdvocate: new DevilsAdvocateAgent(makeStubAdapter('stub-devil', 'Devil text.')),
    synthesizer: new SynthesizerAgent(makeSynthStub()),
    redAgent: new RedAgent(makeStubAdapter('stub-red', 'Red disrupts.')),
    sentry: new SentryAgent(makeSentryStub()),
  };
}

function makeResolver(bundle: ReturnType<typeof buildAgents>): NeurotypeResolver {
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

let auditPath: string;

beforeEach(() => {
  auditPath = join(
    tmpdir(),
    `parliament-topo-lattice-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
  );
});

afterEach(async () => {
  try {
    await fs.unlink(auditPath);
  } catch {
    // ignore
  }
});

describe('runTopology — Lattice integration', () => {
  it('wraps sequential critics on the debate preset and surfaces a LatticeReport', async () => {
    const bundle = buildAgents();
    const topology = loadTopology(parse(`[topology]\nactive = "debate"\n`));

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
      lattice: { enabled: true, auditLogPath: auditPath, shadowMode: true },
    });

    expect(result.lattice).toBeDefined();
    const report = result.lattice!;
    expect(report.enabled).toBe(true);
    expect(report.traceId).toBeTruthy();

    // Debate runs 2 critics (proposer + skeptic) for 1 round = 2 outcomes.
    // Role is the agent's architectural archetype (proposer → 'structured',
    // skeptic → 'critical'), not the topology step ID.
    expect(report.modelOutcomes).toHaveLength(2);
    const roles = report.modelOutcomes.map((o) => o.role).sort();
    expect(roles).toEqual(['critical', 'structured']);
    // 'critical' (skeptic) is adversarial → L1-only. 'structured' (proposer) → L1+L2.
    const skeptic = report.modelOutcomes.find((o) => o.role === 'critical')!;
    expect(skeptic.isAdversarial).toBe(true);
    expect(skeptic.breakerTier).toBe('L1');
    const proposer = report.modelOutcomes.find((o) => o.role === 'structured')!;
    expect(proposer.isAdversarial).toBe(false);
    expect(proposer.breakerTier).toBe('L1+L2');

    // Synthesis should have the appended report block.
    expect(typeof result.synthesis).toBe('string');
    expect(result.synthesis).toContain('## Lattice Coordination Report');

    // Audit log: one line per wrapped call (2). Synthesizer/Sentry/RedAgent
    // are NOT wrapped.
    const contents = await fs.readFile(auditPath, 'utf8');
    const lines = contents.trim().split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);

    // Each entry carries wall-clock timing fields so callers can compute
    // Lattice overhead without depending on adapter internals.
    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(typeof entry['wrapMs']).toBe('number');
    expect(typeof entry['modelCallMs']).toBe('number');
    expect(typeof entry['latticeOverheadMs']).toBe('number');
    expect(entry['latticeOverheadMs'] as number).toBeGreaterThanOrEqual(0);
  });

  it('wraps parallel critics on the jury preset (executeParallelBlock path)', async () => {
    const bundle = buildAgents();
    const topology = loadTopology(parse(`[topology]\nactive = "jury"\n`));

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
      lattice: { enabled: true, auditLogPath: auditPath, shadowMode: true },
    });

    expect(result.lattice).toBeDefined();
    const report = result.lattice!;
    // Jury: proposer (sequential) + 4 critics (parallel) = 5 wrapped calls.
    // Roles are agent archetypes: structured/critical/empiricist/steelmanner/devils-advocate.
    expect(report.modelOutcomes).toHaveLength(5);
    const roles = report.modelOutcomes.map((o) => o.role).sort();
    expect(roles).toEqual(
      ['critical', 'devils-advocate', 'empiricist', 'steelmanner', 'structured'],
    );

    // Adversarial archetypes should be flagged as L1-only.
    const skeptic = report.modelOutcomes.find((o) => o.role === 'critical')!;
    expect(skeptic.breakerTier).toBe('L1');
    const devil = report.modelOutcomes.find((o) => o.role === 'devils-advocate')!;
    expect(devil.breakerTier).toBe('L1');

    // Cooperative archetypes get L1+L2.
    const empiricist = report.modelOutcomes.find((o) => o.role === 'empiricist')!;
    expect(empiricist.breakerTier).toBe('L1+L2');

    const contents = await fs.readFile(auditPath, 'utf8');
    const lines = contents.trim().split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(5);
  });

  it('is a no-op when lattice.enabled is false', async () => {
    const bundle = buildAgents();
    const topology = loadTopology(parse(`[topology]\nactive = "debate"\n`));

    const engine = new DeliberationEngine();
    const result = await engine.runTopology('quiet topic', {
      maxRounds: 1,
      redAgentInterval: 99,
      confidenceThreshold: 0.7,
      topology,
      resolveNeurotype: makeResolver(bundle),
      synthesizer: bundle.synthesizer,
      redAgent: bundle.redAgent,
      sentry: bundle.sentry,
      lattice: { enabled: false, auditLogPath: auditPath },
    });

    expect(result.lattice).toBeUndefined();
    if (typeof result.synthesis === 'string') {
      expect(result.synthesis).not.toContain('Lattice Coordination Report');
    }
    await expect(fs.access(auditPath)).rejects.toThrow();
  });

  it('omits the lattice config entirely (legacy callers see no behavior change)', async () => {
    const bundle = buildAgents();
    const topology = loadTopology(parse(`[topology]\nactive = "debate"\n`));

    const engine = new DeliberationEngine();
    const result = await engine.runTopology('legacy', {
      maxRounds: 1,
      redAgentInterval: 99,
      confidenceThreshold: 0.7,
      topology,
      resolveNeurotype: makeResolver(bundle),
      synthesizer: bundle.synthesizer,
      redAgent: bundle.redAgent,
      sentry: bundle.sentry,
    });

    expect(result.lattice).toBeUndefined();
  });
});
