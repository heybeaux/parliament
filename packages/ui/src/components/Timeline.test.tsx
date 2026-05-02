/**
 * PAR-4 — Timeline grouping of parallel siblings.
 *
 * The Jury preset (Stage 4) emits Skeptic + Empiricist + Steelmanner +
 * Devil's Advocate as a parallel block; the engine tags each sibling with the
 * same `parallel_group` UUID. Timeline.tsx must group consecutive turns that
 * share a `parallel_group` into a single horizontal row container so the
 * parallelism is visually apparent. Sequential transcripts (Debate, Socratic,
 * etc.) and pre-Stage-4 legacy transcripts (no `parallel_group` anywhere)
 * must continue to render in the existing vertical / responsive-grid layout.
 *
 * These tests cover the four ACs from the ticket:
 *   1. Jury fixture renders the parallel block as a single sibling row.
 *   2. Sibling cards appear in registration order (preserve API order).
 *   3. Debate fixture (4 sequential turns) renders with no parallel-row
 *      container — it stays in the original responsive grid.
 *   4. Legacy transcripts (no `parallel_group` field anywhere) render
 *      identically to the sequential case.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { Timeline } from './Timeline';
import type { DeliberationResult, Turn } from '../lib/types';

// ---------------------------------------------------------------------------
// Test fixtures.
// ---------------------------------------------------------------------------

const STARTED_AT = '2026-05-02T12:00:00.000Z';
const COMPLETED_AT = '2026-05-02T12:00:30.000Z';
const JURY_GROUP = '11111111-2222-3333-4444-555555555555';

function makeTurn(overrides: Partial<Turn> & { agent: string }): Turn {
  return {
    agent: overrides.agent,
    neurotype: overrides.neurotype ?? overrides.agent.toLowerCase(),
    model: overrides.model ?? 'mock-model',
    content: overrides.content ?? `${overrides.agent} content`,
    timestamp: overrides.timestamp ?? STARTED_AT,
    round: overrides.round ?? 1,
    osi_score: overrides.osi_score,
    parallel_group: overrides.parallel_group,
  };
}

function makeResult(turns: Turn[]): DeliberationResult {
  return {
    topic: 'Test topic',
    turns,
    conflicts: [],
    residueScore: 0,
    resolved: true,
    synthesis: null,
    split: null,
    terminationReason: 'consensus',
    totalRounds: 1,
    started_at: STARTED_AT,
    completed_at: COMPLETED_AT,
  };
}

// Jury: four siblings inside one `parallel_steps` block. Registration order
// is Skeptic → Empiricist → Steelmanner → Devil's Advocate; the runtime
// guarantees results are appended in this order regardless of completion
// order, and the UI must not re-sort.
const JURY_TURNS: Turn[] = [
  makeTurn({ agent: 'Skeptic', parallel_group: JURY_GROUP }),
  makeTurn({ agent: 'Empiricist', parallel_group: JURY_GROUP }),
  makeTurn({ agent: 'Steelmanner', parallel_group: JURY_GROUP }),
  makeTurn({ agent: 'DevilsAdvocate', parallel_group: JURY_GROUP }),
];

// Debate: four sequential turns across two rounds, no `parallel_group`.
const DEBATE_TURNS: Turn[] = [
  makeTurn({ agent: 'Proposer', round: 1, parallel_group: null }),
  makeTurn({ agent: 'Skeptic', round: 1, parallel_group: null }),
  makeTurn({ agent: 'Proposer', round: 2, parallel_group: null }),
  makeTurn({ agent: 'Skeptic', round: 2, parallel_group: null }),
];

// Legacy: pre-Stage-4 transcripts — no `parallel_group` field on any turn,
// not even set to null. Old persisted deliberations look like this.
const LEGACY_TURNS: Turn[] = [
  makeTurn({ agent: 'Proposer' }),
  makeTurn({ agent: 'Skeptic' }),
  makeTurn({ agent: 'Synthesizer' }),
];

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe('Timeline parallel-sibling grouping (PAR-4)', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders 4 Jury siblings inside a single parallel-row container', () => {
    render(
      <Timeline
        result={makeResult(JURY_TURNS)}
        running={false}
        elapsedSec={0}
        topic="Jury topic"
      />,
    );

    const rows = screen.getAllByTestId('parallel-row');
    expect(rows).toHaveLength(1);

    const row = rows[0]!;
    expect(row.getAttribute('data-parallel-group')).toBe(JURY_GROUP);

    // All four sibling agent labels are inside the row.
    expect(within(row).getByText('Skeptic')).toBeInTheDocument();
    expect(within(row).getByText('Empiricist')).toBeInTheDocument();
    // The Steelmanner / DevilsAdvocate roles fall through to the fallback
    // role-style which echoes the agent name verbatim as the badge label.
    expect(within(row).getByText('Steelmanner')).toBeInTheDocument();
    expect(within(row).getByText('DevilsAdvocate')).toBeInTheDocument();

    // The "Parallel block" badge is rendered once per parallel segment.
    expect(within(row).getByText(/parallel block/i)).toBeInTheDocument();
    expect(within(row).getByText(/4 siblings/i)).toBeInTheDocument();
  });

  it('preserves registration order of Jury siblings (no sorting)', () => {
    render(
      <Timeline
        result={makeResult(JURY_TURNS)}
        running={false}
        elapsedSec={0}
        topic="Jury topic"
      />,
    );

    const row = screen.getByTestId('parallel-row');
    // The card "label" is rendered as the role badge text; the role-style
    // helper falls back to the literal `agent` string when no preset style
    // exists. Probing all four labels in document order verifies the engine's
    // registration order survives the UI layer unchanged.
    const labels = within(row).getAllByText(
      /^Skeptic$|^Empiricist$|^Steelmanner$|^DevilsAdvocate$/,
    );
    expect(labels.map((el) => el.textContent)).toEqual([
      'Skeptic',
      'Empiricist',
      'Steelmanner',
      'DevilsAdvocate',
    ]);
  });

  it('renders 4 Debate turns vertically with no parallel-row container', () => {
    render(
      <Timeline
        result={makeResult(DEBATE_TURNS)}
        running={false}
        elapsedSec={0}
        topic="Debate topic"
      />,
    );

    // No parallel-row containers anywhere — this is the AC for sequential
    // transcripts rendering unchanged.
    expect(screen.queryAllByTestId('parallel-row')).toHaveLength(0);

    // All four sequential agent labels are still rendered.
    expect(screen.getAllByText('Proposer')).toHaveLength(2);
    expect(screen.getAllByText('Skeptic')).toHaveLength(2);

    // Round headers are present for both rounds.
    expect(screen.getByText(/Round 1/i)).toBeInTheDocument();
    expect(screen.getByText(/Round 2/i)).toBeInTheDocument();
  });

  it('renders legacy transcripts (no parallel_group field) unchanged', () => {
    render(
      <Timeline
        result={makeResult(LEGACY_TURNS)}
        running={false}
        elapsedSec={0}
        topic="Legacy topic"
      />,
    );

    expect(screen.queryAllByTestId('parallel-row')).toHaveLength(0);
    expect(screen.getByText('Proposer')).toBeInTheDocument();
    expect(screen.getByText('Skeptic')).toBeInTheDocument();
    expect(screen.getByText('Synthesizer')).toBeInTheDocument();
  });
});

/**
 * PAR-24 — deliberation totals row.
 *
 * The result-view header sums per-turn telemetry across every turn that
 * carries `meta`. Per-field chips hide independently; the row collapses
 * entirely when no turn populated any meta.
 */
describe('Timeline deliberation totals (PAR-24)', () => {
  afterEach(() => {
    cleanup();
  });

  it('sums latency / tokens / cost across mixed turns and shows all chips', () => {
    const turns: Turn[] = [
      makeTurn({
        agent: 'Proposer',
        round: 1,
        timestamp: STARTED_AT,
      }),
      makeTurn({
        agent: 'Skeptic',
        round: 1,
        timestamp: STARTED_AT,
      }),
      makeTurn({
        agent: 'Synthesizer',
        round: 1,
        timestamp: STARTED_AT,
      }),
    ];
    // Turn 0 — full openrouter telemetry.
    turns[0]!.meta = {
      latencyMs: 1500,
      promptTokens: 100,
      completionTokens: 50,
      costUsd: 0.0021,
      provider: 'openrouter',
    };
    // Turn 1 — local provider, no cost.
    turns[1]!.meta = {
      latencyMs: 800,
      promptTokens: 80,
      completionTokens: 40,
      provider: 'omlx',
    };
    // Turn 2 — pre-PAR-23 turn, no meta. Should not contribute.

    render(
      <Timeline
        result={makeResult(turns)}
        running={false}
        elapsedSec={0}
        topic="Mixed topic"
      />,
    );

    const totals = screen.getByTestId('deliberation-totals');

    // Compute total = 1500ms + 800ms = 2300ms → 2.3s.
    expect(within(totals).getByText('2.3s')).toBeInTheDocument();
    // Tokens summed: prompt 180 → completion 90.
    expect(within(totals).getByText(/180\s*\u2192\s*90/)).toBeInTheDocument();
    // Cost summed: only turn 0 contributed (0.0021).
    expect(within(totals).getByText('$0.0021')).toBeInTheDocument();
  });

  it('hides the cost chip when no turn carries costUsd', () => {
    const turns: Turn[] = [
      makeTurn({ agent: 'Proposer', round: 1, timestamp: STARTED_AT }),
      makeTurn({ agent: 'Skeptic', round: 1, timestamp: STARTED_AT }),
    ];
    turns[0]!.meta = {
      latencyMs: 600,
      promptTokens: 100,
      completionTokens: 50,
      provider: 'omlx',
    };
    turns[1]!.meta = {
      latencyMs: 700,
      promptTokens: 80,
      completionTokens: 40,
      provider: 'omlx',
    };

    render(
      <Timeline
        result={makeResult(turns)}
        running={false}
        elapsedSec={0}
        topic="Local-only topic"
      />,
    );

    const totals = screen.getByTestId('deliberation-totals');

    // Compute and tokens still render…
    expect(within(totals).getByText('1.3s')).toBeInTheDocument();
    expect(within(totals).getByText(/180\s*\u2192\s*90/)).toBeInTheDocument();
    // …but no cost chip — there's no $-prefixed 4-decimal value.
    expect(within(totals).queryByText(/^\$\d+\.\d{4}$/)).toBeNull();
  });

  it('hides the totals row entirely when no turn has any meta', () => {
    render(
      <Timeline
        result={makeResult(LEGACY_TURNS)}
        running={false}
        elapsedSec={0}
        topic="Legacy topic"
      />,
    );

    expect(screen.queryByTestId('deliberation-totals')).not.toBeInTheDocument();
  });
});
