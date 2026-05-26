/**
 * Integration test for the Lattice wrap inside `runIdeation`.
 *
 * Strategy:
 *   - Use the same scripted-adapter factory pattern as orchestrator.test.ts
 *     so we don't make any real network/model calls.
 *   - Run the orchestrator with `lattice.enabled: true` and a tmp audit log.
 *   - Assert:
 *       1. The result carries a structured `LatticeReport` with the expected
 *          `traceId`, `agreementRatio`, `consensusReached`, and per-model
 *          outcomes.
 *       2. The orchestrator appended the canonical "Lattice Coordination
 *          Report" block to the synthesis output.
 *       3. The audit log file at the configured path is non-empty and
 *          contains a JSONL line for each wrapped model call (cooperative +
 *          adversarial + rebuttal where applicable).
 *       4. With `lattice.enabled: false`, the result has no `lattice`
 *          field and no audit log is written.
 *       5. Conflict detection: when cooperative agents emit divergent
 *          first-sentence content, ParliamentReducer surfaces conflicts on
 *          the `mainPoint` field.
 */

import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ModelAdapter, AdapterResult } from '../../adapters/base.js';
import { defaultLineup } from '../lineup.js';
import { runIdeation, type AdapterFactory } from '../orchestrator.js';

type Script = Record<string, string | (() => string)>;

function makeFactory(script: Script): AdapterFactory {
  return (model: string): ModelAdapter => ({
    modelName: model,
    async generate(_prompt: string, system?: string): Promise<AdapterResult> {
      const key = `${model}::${(system ?? '').split('\n')[0] ?? ''}`;
      const fallbackKey = `*::${(system ?? '').split('\n')[0] ?? ''}`;
      const value = script[key] ?? script[fallbackKey];
      if (value === undefined) {
        throw new Error(`Test stub: no script entry for "${key}" or "${fallbackKey}"`);
      }
      return { content: typeof value === 'function' ? value() : value };
    },
  });
}

const ANY = '*';

const COOPERATIVE_SCRIPT: Script = {
  [`${ANY}::You are the Proposer in a cooperative product-ideation team.`]: 'Identical conclusion. More detail.',
  [`${ANY}::You are the Expander in a cooperative product-ideation team.`]: 'Identical conclusion. More detail.',
  [`${ANY}::You are the Pragmatist in a cooperative product-ideation team.`]: 'Identical conclusion. More detail.',
  [`${ANY}::You are the Lateralist in a cooperative product-ideation team.`]: 'Identical conclusion. More detail.',
  [`${ANY}::You are synthesizing a product-ideation transcript into a final ideation document.`]: 'final synthesis',
};

let auditPath: string;

beforeEach(() => {
  auditPath = join(tmpdir(), `parliament-lattice-test-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
});

afterEach(async () => {
  try {
    await fs.unlink(auditPath);
  } catch {
    // ignore — the test may not have created the file
  }
});

describe('runIdeation — Lattice integration (PAR-Lattice)', () => {
  it('wraps each model call and surfaces a LatticeReport when enabled', async () => {
    const lineup = defaultLineup('cooperative');
    const factory = makeFactory(COOPERATIVE_SCRIPT);
    const result = await runIdeation(
      {
        idea: 'A wearable that detects mood drift',
        mode: 'cooperative',
        style: 'collective',
        lineup,
        lattice: { enabled: true, auditLogPath: auditPath, shadowMode: true },
      },
      factory,
    );

    expect(result.status).toBe('complete');
    expect(result.lattice).toBeDefined();
    const report = result.lattice!;
    expect(report.enabled).toBe(true);
    expect(report.traceId).toBeTruthy();
    // 4 cooperative models — all should appear with the L1+L2 tier label
    // (cooperative roles never run on L1 only). The `passed` field depends
    // on whether the L2 semantic-similarity check has an embedding provider
    // wired up; in the test harness it doesn't, so we assert only the wrap
    // shape — not the breaker outcome.
    expect(report.modelOutcomes).toHaveLength(4);
    for (const outcome of report.modelOutcomes) {
      expect(outcome.isAdversarial).toBe(false);
      expect(outcome.breakerTier).toBe('L1+L2');
      expect(typeof outcome.passed).toBe('boolean');
    }
    // 4 cooperative agents agreed on every consensus field by construction —
    // agreement ratio should be 1.0 and consensus should be reached.
    expect(report.agreementRatio).toBe(1);
    expect(report.consensusReached).toBe(true);
    expect(report.conflicts).toEqual([]);
  });

  it('appends the "Lattice Coordination Report" block to the synthesis', async () => {
    const lineup = defaultLineup('cooperative');
    const factory = makeFactory(COOPERATIVE_SCRIPT);
    const result = await runIdeation(
      {
        idea: 'idea',
        mode: 'cooperative',
        style: 'collective',
        lineup,
        lattice: { enabled: true, auditLogPath: auditPath },
      },
      factory,
    );

    expect(result.synthesis).toContain('## Lattice Coordination Report');
    expect(result.synthesis).toContain('- Trace ID:');
    expect(result.synthesis).toContain('- Agreement Ratio:');
    expect(result.synthesis).toContain('- Consensus:');
    expect(result.synthesis).toContain('- Conflicts:');
    expect(result.synthesis).toContain('- Model Pass Rates:');
    expect(result.synthesis).toContain('- Audit Log:');
  });

  it('writes a JSONL audit log entry per wrapped model call', async () => {
    const lineup = defaultLineup('cooperative');
    const factory = makeFactory(COOPERATIVE_SCRIPT);
    await runIdeation(
      {
        idea: 'idea',
        mode: 'cooperative',
        style: 'collective',
        lineup,
        lattice: { enabled: true, auditLogPath: auditPath },
      },
      factory,
    );

    const contents = await fs.readFile(auditPath, 'utf8');
    const lines = contents.trim().split('\n').filter((l) => l.length > 0);
    // 4 cooperative agents = 4 wrap calls = 4 audit entries (synth runs OUTSIDE
    // the wrap because the synthesizer is a single trusted aggregator).
    expect(lines).toHaveLength(4);
    for (const line of lines) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(parsed['traceId']).toBeTruthy();
      expect(parsed['agentId']).toBeTruthy();
      expect(parsed['role']).toBeTruthy();
      // `passed` depends on whether the L2 semantic-similarity judge ran;
      // we just assert the field is a boolean, not its value.
      expect(typeof parsed['passed']).toBe('boolean');
      expect(parsed['contractId']).toBeTruthy();
      expect(parsed['timestamp']).toBeTruthy();
    }
  });

  it('skips Lattice entirely when enabled is false (legacy path, no audit log)', async () => {
    const lineup = defaultLineup('cooperative');
    const factory = makeFactory(COOPERATIVE_SCRIPT);
    const result = await runIdeation(
      {
        idea: 'idea',
        mode: 'cooperative',
        style: 'collective',
        lineup,
        lattice: { enabled: false, auditLogPath: auditPath },
      },
      factory,
    );

    expect(result.status).toBe('complete');
    expect(result.lattice).toBeUndefined();
    // No audit log should be created.
    await expect(fs.access(auditPath)).rejects.toThrow();
    // No "Lattice Coordination Report" block in the synthesis either.
    expect(result.synthesis).not.toContain('Lattice Coordination Report');
  });

  it('omits the lattice block by default (no opts.lattice supplied)', async () => {
    const lineup = defaultLineup('cooperative');
    const factory = makeFactory(COOPERATIVE_SCRIPT);
    const result = await runIdeation(
      { idea: 'idea', mode: 'cooperative', style: 'collective', lineup },
      factory,
    );
    expect(result.lattice).toBeUndefined();
  });

  it('detects conflicts when cooperative agents emit divergent mainPoint sentences', async () => {
    const lineup = defaultLineup('cooperative');
    // Each cooperative agent emits a DIFFERENT first-sentence "mainPoint", so
    // ParliamentReducer should flag a conflict on the mainPoint field. The
    // adapter's first-sentence rule splits on `(?<=[.!?])\s+`, so we use one
    // sentence per agent.
    const factory = makeFactory({
      [`${ANY}::You are the Proposer in a cooperative product-ideation team.`]: 'Build for runners.',
      [`${ANY}::You are the Expander in a cooperative product-ideation team.`]: 'Build for cyclists.',
      [`${ANY}::You are the Pragmatist in a cooperative product-ideation team.`]: 'Build for swimmers.',
      [`${ANY}::You are the Lateralist in a cooperative product-ideation team.`]: 'Build for hikers.',
      [`${ANY}::You are synthesizing a product-ideation transcript into a final ideation document.`]: 'S',
    });

    const result = await runIdeation(
      {
        idea: 'A wearable',
        mode: 'cooperative',
        style: 'individual',
        lineup,
        lattice: { enabled: true, auditLogPath: auditPath, minAgreementRatio: 0.6 },
      },
      factory,
    );

    expect(result.lattice).toBeDefined();
    const report = result.lattice!;
    // 4 distinct mainPoint values across 4 agents -> agreement ratio drops.
    expect(report.agreementRatio).toBeLessThan(1);
    expect(report.consensusReached).toBe(false);
    // At least one conflict should be flagged on the mainPoint field.
    const fields = report.conflicts.map((c) => c.field);
    expect(fields).toContain('mainPoint');
  });
});
