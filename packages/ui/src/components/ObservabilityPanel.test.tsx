/**
 * PAR-5 — Component tests for the Observability panel.
 *
 * Coverage goals (from the ticket's acceptance criteria):
 *   - Toggle opens/closes the panel; closed by default.
 *   - Sparkline, residue chart, and event list render with real data.
 *   - Empty `events: []` renders a friendly empty state, not a broken chart.
 *   - Plain-language labels are visible; research terms are surfaced via
 *     tooltip / aria-label.
 *   - Missing-fields fallback: turns without `convergence_delta`, an absent
 *     `events` field, and a null `result` all degrade gracefully.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Timeline } from './Timeline';
import {
  ObservabilityPanel,
  buildRoundMetrics,
} from './ObservabilityPanel';
import type { DeliberationResult, SystemEvent, Turn } from '../lib/types';

afterEach(() => {
  cleanup();
});

function makeTurn(overrides: Partial<Turn>): Turn {
  return {
    agent: 'Proposer',
    neurotype: 'evidence-first',
    model: 'mock-model',
    content: 'placeholder',
    timestamp: '2026-05-01T12:00:00.000Z',
    round: 1,
    ...overrides,
  };
}

function makeResult(overrides: Partial<DeliberationResult>): DeliberationResult {
  return {
    topic: 'Test topic',
    turns: [],
    conflicts: [],
    residueScore: 0,
    resolved: true,
    synthesis: null,
    split: null,
    terminationReason: 'consensus',
    totalRounds: 0,
    started_at: '2026-05-01T12:00:00.000Z',
    completed_at: '2026-05-01T12:00:30.000Z',
    events: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Toggle
// ---------------------------------------------------------------------------

describe('Timeline observability toggle (PAR-5)', () => {
  it('hides the panel by default and reveals it when the toggle is clicked', async () => {
    const result = makeResult({
      turns: [makeTurn({ round: 1, convergence_delta: null })],
      totalRounds: 1,
    });
    const user = userEvent.setup();

    render(
      <Timeline result={result} running={false} elapsedSec={0} topic="Test" />,
    );

    // Closed by default: panel test-id absent.
    expect(screen.queryByTestId('observability-panel')).toBeNull();

    const toggle = screen.getByRole('button', { name: /show observability/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    await user.click(toggle);

    expect(screen.getByTestId('observability-panel')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /hide observability/i }),
    ).toHaveAttribute('aria-expanded', 'true');

    // Toggling again closes it.
    await user.click(screen.getByRole('button', { name: /hide observability/i }));
    expect(screen.queryByTestId('observability-panel')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Populated state
// ---------------------------------------------------------------------------

describe('ObservabilityPanel populated (PAR-5)', () => {
  it('renders sparkline, residue bars, and event list with real data', () => {
    const turns: Turn[] = [
      makeTurn({ round: 1, convergence_delta: null }),
      makeTurn({ round: 2, convergence_delta: 0.4 }),
      makeTurn({ round: 3, convergence_delta: -0.1 }),
    ];
    const events: SystemEvent[] = [
      { round: 2, kind: 'red_agent.injection', message: 'RedAgent challenges the assumption.' },
      { round: 3, kind: 'sentry.echo', message: 'Sentry detected echo collapse.' },
    ];
    const result = makeResult({
      turns,
      events,
      totalRounds: 3,
      residueScore: 0.42,
    });

    render(<ObservabilityPanel result={result} open />);

    // Plain-language labels visible (look for the heading-level h4s).
    expect(
      screen.getByRole('heading', { level: 4, name: /Room movement/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 4, name: /Disagreement remaining/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 4, name: /Interventions/i }),
    ).toBeInTheDocument();

    // Research terms surfaced via aria-label / title.
    const sparkline = screen.getByRole('img', {
      name: /convergence_delta sparkline/i,
    });
    expect(sparkline).toBeInTheDocument();

    const bars = screen.getByRole('img', {
      name: /residue of conflict/i,
    });
    expect(bars).toBeInTheDocument();

    // Event messages render with plain-language kind labels.
    expect(
      screen.getByText('RedAgent challenges the assumption.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Sentry detected echo collapse.'),
    ).toBeInTheDocument();
    expect(screen.getByText(/Devil-advocate injection/i)).toBeInTheDocument();
    expect(screen.getByText(/Echo-collapse warning/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Empty events
// ---------------------------------------------------------------------------

describe('ObservabilityPanel empty events (PAR-5)', () => {
  it('shows a friendly empty state when events: [] and never breaks the charts', () => {
    const result = makeResult({
      turns: [
        makeTurn({ round: 1, convergence_delta: null }),
        makeTurn({ round: 2, convergence_delta: 0.2 }),
      ],
      events: [],
      totalRounds: 2,
    });

    render(<ObservabilityPanel result={result} open />);

    // Empty-state copy is friendly, not error-y.
    expect(screen.getByText(/No interventions/i)).toBeInTheDocument();
    expect(
      screen.getByText(/No devil-advocate injections or echo-collapse warnings/i),
    ).toBeInTheDocument();

    // Charts still render alongside the empty event state.
    expect(
      screen.getByRole('img', { name: /convergence_delta sparkline/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('img', { name: /residue of conflict/i }),
    ).toBeInTheDocument();
  });

  it('treats an absent events field as []', () => {
    const result = makeResult({
      turns: [makeTurn({ round: 1, convergence_delta: null })],
      totalRounds: 1,
    });
    // Strip events to simulate an old transcript.
    const { events: _events, ...rest } = result;
    const stripped = rest as DeliberationResult;
    expect(stripped.events).toBeUndefined();

    render(<ObservabilityPanel result={stripped} open />);
    expect(screen.getByText(/No interventions/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Missing-fields fallback
// ---------------------------------------------------------------------------

describe('ObservabilityPanel missing-fields fallback (PAR-5)', () => {
  it('renders without crashing when turns lack convergence_delta', () => {
    const result = makeResult({
      turns: [
        makeTurn({ round: 1 }),
        makeTurn({ round: 2 }),
        makeTurn({ round: 3 }),
      ],
      totalRounds: 3,
    });

    render(<ObservabilityPanel result={result} open />);
    // Both charts render even though every delta is missing.
    expect(
      screen.getByRole('img', { name: /convergence_delta sparkline/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('img', { name: /residue of conflict/i }),
    ).toBeInTheDocument();
  });

  it('renders an explanatory empty card when result is null but the panel is open', () => {
    render(<ObservabilityPanel result={null} open />);
    expect(
      screen.getByText(/Run a deliberation to see room movement/i),
    ).toBeInTheDocument();
  });

  it('tolerates malformed event entries gracefully', () => {
    const events = [
      { round: 1, kind: 'red_agent.injection', message: 'first' },
      // simulate a stored event missing fields
      { round: 2, kind: undefined as unknown as 'red_agent.injection', message: undefined as unknown as string },
    ] as SystemEvent[];

    const result = makeResult({
      turns: [makeTurn({ round: 1, convergence_delta: 0.1 })],
      events,
      totalRounds: 1,
    });

    render(<ObservabilityPanel result={result} open />);
    expect(screen.getByText('first')).toBeInTheDocument();
    expect(screen.getByText('(no description)')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Pure derivation
// ---------------------------------------------------------------------------

describe('buildRoundMetrics (PAR-5)', () => {
  it('groups turns by round and accumulates convergence_delta', () => {
    const turns = [
      makeTurn({ round: 1, convergence_delta: null }),
      makeTurn({ round: 2, convergence_delta: 0.3 }),
      makeTurn({ round: 2, convergence_delta: 0.3 }), // sibling, same delta
      makeTurn({ round: 3, convergence_delta: -0.1 }),
    ];

    const metrics = buildRoundMetrics(turns);
    expect(metrics).toHaveLength(3);
    expect(metrics[0]).toMatchObject({ round: 1, movement: 0, hasDelta: false });
    expect(metrics[1]).toMatchObject({ round: 2, movement: 0.3, hasDelta: true });
    expect(metrics[2]).toMatchObject({ round: 3, movement: 0.1, hasDelta: true });
    // Cumulative sums signed deltas across rounds.
    expect(metrics[2]!.cumulative).toBeCloseTo(0.2, 4);
  });

  it('returns [] when there are no turns', () => {
    expect(buildRoundMetrics([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Mounting via Timeline header — sanity check the integration.
// ---------------------------------------------------------------------------

describe('Timeline + ObservabilityPanel integration (PAR-5)', () => {
  it('surfaces the panel under the Timeline header when toggled', async () => {
    const result = makeResult({
      turns: [
        makeTurn({ round: 1, convergence_delta: null }),
        makeTurn({ round: 2, convergence_delta: 0.5 }),
      ],
      events: [
        { round: 2, kind: 'red_agent.injection', message: 'Challenge fired.' },
      ],
      totalRounds: 2,
    });
    const user = userEvent.setup();

    render(
      <Timeline result={result} running={false} elapsedSec={0} topic="T" />,
    );

    await user.click(screen.getByRole('button', { name: /show observability/i }));

    const panel = screen.getByTestId('observability-panel');
    expect(within(panel).getByText('Challenge fired.')).toBeInTheDocument();
  });
});

