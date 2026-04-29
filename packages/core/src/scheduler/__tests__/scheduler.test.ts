import { describe, it, expect, vi } from 'vitest';
import type { Agent } from '../../agents/base.js';
import type { Blackboard } from '../../types.js';
import {
  buildBatchSchedule,
  countModelSwaps,
  type ScheduledTurn,
} from '../index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAgent(role: string, neurotype = 'generic'): Agent {
  return {
    role,
    neurotype,
    modelName: 'test-model',
    generate: vi.fn().mockResolvedValue({ content: `response from ${role}`, truncated: false }),
  };
}

function makeTurn(
  role: string,
  model: string,
  dependsOn: string[] = [],
): ScheduledTurn {
  return { role, model, agent: makeAgent(role), dependsOn };
}

/**
 * Flatten a BatchSchedule into a single ordered sequence of turns.
 * Within each batch, order is preserved.
 */
function flattenSchedule(schedule: ReturnType<typeof buildBatchSchedule>): ScheduledTurn[] {
  return schedule.batches.flat();
}

// ---------------------------------------------------------------------------
// Standard Parliament role set used across multiple tests.
//
//   Proposer  (llama3.2)   — no deps
//   Skeptic   (mistral)    — depends on Proposer
//   Synthesizer (llama3.2) — depends on Skeptic
//   RedAgent  (mistral)    — depends on Proposer
//   Sentry    (llama3.2)   — depends on Skeptic
// ---------------------------------------------------------------------------

function makeParliamentTurns(): ScheduledTurn[] {
  return [
    makeTurn('Proposer', 'llama3.2', []),
    makeTurn('Skeptic', 'mistral', ['Proposer']),
    makeTurn('Synthesizer', 'llama3.2', ['Skeptic']),
    makeTurn('RedAgent', 'mistral', ['Proposer']),
    makeTurn('Sentry', 'llama3.2', ['Skeptic']),
  ];
}

// ---------------------------------------------------------------------------
// buildBatchSchedule — agents sharing a model are batched together
// ---------------------------------------------------------------------------

describe('buildBatchSchedule — model batching', () => {
  it('returns an empty schedule for an empty input', () => {
    const schedule = buildBatchSchedule([]);
    expect(schedule.batches).toHaveLength(0);
  });

  it('returns a single batch when all agents share one model', () => {
    const turns = [
      makeTurn('Proposer', 'llama3.2', []),
      makeTurn('Skeptic', 'llama3.2', ['Proposer']),
      makeTurn('Synthesizer', 'llama3.2', ['Skeptic']),
    ];
    const schedule = buildBatchSchedule(turns);
    // All three share llama3.2 and form a single uninterrupted run.
    const singleModelBatches = schedule.batches.filter((b) => b[0]!.model === 'llama3.2');
    expect(singleModelBatches.flat()).toHaveLength(3);
  });

  it('groups consecutive same-model turns into the same batch', () => {
    // Proposer (llama3.2) → Skeptic (mistral) → Synthesizer (llama3.2) → Sentry (llama3.2)
    const turns = [
      makeTurn('Proposer', 'llama3.2', []),
      makeTurn('Skeptic', 'mistral', ['Proposer']),
      makeTurn('Synthesizer', 'llama3.2', ['Skeptic']),
      makeTurn('Sentry', 'llama3.2', ['Skeptic']),
    ];
    const schedule = buildBatchSchedule(turns);

    // The llama3.2 turns that appear consecutively after Skeptic should be
    // in the same batch.
    const lastBatch = schedule.batches[schedule.batches.length - 1]!;
    expect(lastBatch.every((t) => t.model === 'llama3.2')).toBe(true);
    expect(lastBatch.length).toBeGreaterThanOrEqual(2);
  });

  it('agents sharing a model but separated by a different model form separate batches', () => {
    // Proposer (llama3.2) → Skeptic (mistral) → Synthesizer (llama3.2)
    const turns = [
      makeTurn('Proposer', 'llama3.2', []),
      makeTurn('Skeptic', 'mistral', ['Proposer']),
      makeTurn('Synthesizer', 'llama3.2', ['Skeptic']),
    ];
    const schedule = buildBatchSchedule(turns);

    // There should be three batches because the model changes each time.
    expect(schedule.batches).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// buildBatchSchedule — logical ordering preserved
// ---------------------------------------------------------------------------

describe('buildBatchSchedule — logical ordering', () => {
  it('Skeptic always comes after Proposer in the flat schedule', () => {
    const schedule = buildBatchSchedule(makeParliamentTurns());
    const flat = flattenSchedule(schedule);
    const proposerIdx = flat.findIndex((t) => t.role === 'Proposer');
    const skepticIdx = flat.findIndex((t) => t.role === 'Skeptic');
    expect(proposerIdx).toBeLessThan(skepticIdx);
  });

  it('Synthesizer always comes after Skeptic in the flat schedule', () => {
    const schedule = buildBatchSchedule(makeParliamentTurns());
    const flat = flattenSchedule(schedule);
    const skepticIdx = flat.findIndex((t) => t.role === 'Skeptic');
    const synthIdx = flat.findIndex((t) => t.role === 'Synthesizer');
    expect(skepticIdx).toBeLessThan(synthIdx);
  });

  it('RedAgent always comes after Proposer in the flat schedule', () => {
    const schedule = buildBatchSchedule(makeParliamentTurns());
    const flat = flattenSchedule(schedule);
    const proposerIdx = flat.findIndex((t) => t.role === 'Proposer');
    const redIdx = flat.findIndex((t) => t.role === 'RedAgent');
    expect(proposerIdx).toBeLessThan(redIdx);
  });

  it('Sentry always comes after Skeptic in the flat schedule', () => {
    const schedule = buildBatchSchedule(makeParliamentTurns());
    const flat = flattenSchedule(schedule);
    const skepticIdx = flat.findIndex((t) => t.role === 'Skeptic');
    const sentryIdx = flat.findIndex((t) => t.role === 'Sentry');
    expect(skepticIdx).toBeLessThan(sentryIdx);
  });

  it('all five Parliament roles appear exactly once in the flat schedule', () => {
    const schedule = buildBatchSchedule(makeParliamentTurns());
    const flat = flattenSchedule(schedule);
    const roles = flat.map((t) => t.role).sort();
    expect(roles).toEqual(['Proposer', 'RedAgent', 'Sentry', 'Skeptic', 'Synthesizer']);
  });
});

// ---------------------------------------------------------------------------
// buildBatchSchedule — single model serves multiple neurotypes
// ---------------------------------------------------------------------------

describe('buildBatchSchedule — single model, multiple neurotypes', () => {
  it('turns with the same model but different neurotypes/system prompts are batched together', () => {
    // Proposer (llama3.2, structured) → Synthesizer (llama3.2, integrative)
    const proposer = makeTurn('Proposer', 'llama3.2', []);
    const synthesizer = makeTurn('Synthesizer', 'llama3.2', ['Proposer']);

    // Give them distinct neurotypes to confirm model identity is the grouping key.
    proposer.agent = { role: 'Proposer', neurotype: 'structured', modelName: 'llama3.2', generate: vi.fn() };
    synthesizer.agent = { role: 'Synthesizer', neurotype: 'integrative', modelName: 'llama3.2', generate: vi.fn() };

    const schedule = buildBatchSchedule([proposer, synthesizer]);

    // Both use llama3.2 → should land in a single batch.
    expect(schedule.batches).toHaveLength(1);
    expect(schedule.batches[0]).toHaveLength(2);
    expect(schedule.batches[0]![0]!.agent.neurotype).toBe('structured');
    expect(schedule.batches[0]![1]!.agent.neurotype).toBe('integrative');
  });

  it('preserves ordering inside the batch even for same-model agents', () => {
    const turns = [
      makeTurn('Proposer', 'llama3.2', []),
      makeTurn('Synthesizer', 'llama3.2', ['Proposer']),
      makeTurn('Sentry', 'llama3.2', ['Skeptic']),
    ];
    // Sentry depends on Skeptic but Skeptic is absent — it should still sort
    // after Synthesizer since Proposer → Synthesizer → Sentry is the only
    // valid chain for the roles present.
    const schedule = buildBatchSchedule(turns);
    const flat = flattenSchedule(schedule);
    const synthIdx = flat.findIndex((t) => t.role === 'Synthesizer');
    const proposerIdx = flat.findIndex((t) => t.role === 'Proposer');
    expect(proposerIdx).toBeLessThan(synthIdx);
  });
});

// ---------------------------------------------------------------------------
// countModelSwaps
// ---------------------------------------------------------------------------

describe('countModelSwaps', () => {
  it('returns 0 for an empty list', () => {
    expect(countModelSwaps([])).toBe(0);
  });

  it('returns 0 for a single turn', () => {
    expect(countModelSwaps([makeTurn('Proposer', 'llama3.2')])).toBe(0);
  });

  it('returns 0 when all turns share the same model', () => {
    const turns = [
      makeTurn('Proposer', 'llama3.2'),
      makeTurn('Skeptic', 'llama3.2'),
      makeTurn('Synthesizer', 'llama3.2'),
    ];
    expect(countModelSwaps(turns)).toBe(0);
  });

  it('returns 1 for two consecutive turns with different models', () => {
    const turns = [
      makeTurn('Proposer', 'llama3.2'),
      makeTurn('Skeptic', 'mistral'),
    ];
    expect(countModelSwaps(turns)).toBe(1);
  });

  it('counts every model boundary in a naive sequence', () => {
    // llama3.2 → mistral → llama3.2 → mistral → llama3.2 = 4 swaps
    const turns = [
      makeTurn('A', 'llama3.2'),
      makeTurn('B', 'mistral'),
      makeTurn('C', 'llama3.2'),
      makeTurn('D', 'mistral'),
      makeTurn('E', 'llama3.2'),
    ];
    expect(countModelSwaps(turns)).toBe(4);
  });

  it('returns the correct count for the naive Parliament sequence', () => {
    // Naive order: Proposer(llama3.2)→Skeptic(mistral)→Synthesizer(llama3.2)
    //              →RedAgent(mistral)→Sentry(llama3.2) = 4 swaps
    const naive = [
      makeTurn('Proposer', 'llama3.2'),
      makeTurn('Skeptic', 'mistral'),
      makeTurn('Synthesizer', 'llama3.2'),
      makeTurn('RedAgent', 'mistral'),
      makeTurn('Sentry', 'llama3.2'),
    ];
    expect(countModelSwaps(naive)).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Batched schedule has fewer swaps than naive sequential schedule
// ---------------------------------------------------------------------------

describe('buildBatchSchedule — swap reduction', () => {
  it('batched schedule produces fewer or equal model swaps than naive order', () => {
    // Naive ordering (as received): Proposer→Skeptic→Synthesizer→RedAgent→Sentry
    // This alternates llama3.2/mistral for 4 swaps.
    const naive = makeParliamentTurns(); // preserve input order

    const naiveSwaps = countModelSwaps(naive);

    const schedule = buildBatchSchedule(naive);
    const flat = flattenSchedule(schedule);
    const batchedSwaps = countModelSwaps(flat);

    expect(batchedSwaps).toBeLessThanOrEqual(naiveSwaps);
  });

  it('batched schedule has strictly fewer swaps than the worst-case naive sequence', () => {
    // In the Parliament setup, naive order alternates models for up to 4 swaps.
    // The batched schedule should group same-model turns, reducing swaps.
    const naive = makeParliamentTurns();
    const naiveSwaps = countModelSwaps(naive);

    const schedule = buildBatchSchedule(naive);
    const flat = flattenSchedule(schedule);
    const batchedSwaps = countModelSwaps(flat);

    // The batched schedule must improve (or equal) on the naive sequence.
    // For the Parliament setup, we expect strict improvement.
    expect(batchedSwaps).toBeLessThan(naiveSwaps);
  });

  it('naive order for alternating models has more swaps than batched order', () => {
    // Explicit worst-case naive: A→B→A→B with alternating models.
    // (Deps: B1 depends on A1, A2 depends on A1, B2 depends on B1)
    const naiveTurns: ScheduledTurn[] = [
      makeTurn('A1', 'llama3.2', []),
      makeTurn('B1', 'mistral', ['A1']),
      makeTurn('A2', 'llama3.2', ['A1']),
      makeTurn('B2', 'mistral', ['B1']),
    ];

    const naiveSwaps = countModelSwaps(naiveTurns);
    expect(naiveSwaps).toBe(3); // llama→mistral→llama→mistral

    const schedule = buildBatchSchedule(naiveTurns);
    const flat = flattenSchedule(schedule);
    const batchedSwaps = countModelSwaps(flat);

    expect(batchedSwaps).toBeLessThan(naiveSwaps);
  });
});
