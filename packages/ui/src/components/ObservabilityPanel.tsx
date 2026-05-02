/**
 * PAR-5 — Observability panel surfaced from the Timeline header.
 *
 * Renders three views over the engine's per-round telemetry:
 *
 *   1. Confidence sparkline — cumulative running sum of `convergence_delta`
 *      across rounds. Plain label "Room movement"; research term
 *      ("convergence_delta cumulative") exposed via tooltip / aria-label.
 *
 *   2. Disagreement-remaining bar chart — per-round bars sized to the
 *      magnitude of `convergence_delta` (|delta|) for that round. The engine
 *      does not currently expose a per-round residue field — only an
 *      end-of-deliberation `residueScore` — so we proxy the per-round signal
 *      with the absolute convergence movement, which tracks how much the
 *      room is still shifting that round. Plain label "Disagreement
 *      remaining"; tooltip surfaces "residue of conflict (per-round proxy)".
 *
 *   3. Event list — `events[]` rendered chronologically with `round`, `kind`,
 *      `message`. Empty `events: []` renders a friendly empty state rather
 *      than a broken chart.
 *
 * Visually muted: low-saturation surface, no animation on the chart bodies,
 * sticks to the existing `surface` / `ring-white/[0.06]` conventions so the
 * panel never dominates the transcript even when open.
 */

import { useMemo } from 'react';
import type { DeliberationResult, SystemEvent, Turn } from '../lib/types';

// ---------------------------------------------------------------------------
// Per-round telemetry derivation
// ---------------------------------------------------------------------------

interface RoundMetric {
  round: number;
  /** Absolute convergence movement for the round; 0 when undefined. */
  movement: number;
  /** Cumulative running sum of signed convergence_delta through this round. */
  cumulative: number;
  /** Whether at least one turn in the round carried a non-null convergence_delta. */
  hasDelta: boolean;
}

/**
 * Walk turns once, group by round, and pick the first non-null
 * `convergence_delta` we see in each round (the server attaches the same
 * delta to every turn in a round, so any turn is representative). Rounds
 * with only null/undefined deltas contribute 0 movement.
 */
export function buildRoundMetrics(turns: readonly Turn[]): RoundMetric[] {
  const byRound = new Map<number, number | null>();
  for (const turn of turns) {
    if (!byRound.has(turn.round)) {
      const delta = turn.convergence_delta ?? null;
      byRound.set(turn.round, delta);
    } else if (byRound.get(turn.round) === null) {
      // First occurrence was null; upgrade if a later turn carries a value.
      const delta = turn.convergence_delta ?? null;
      if (delta !== null) byRound.set(turn.round, delta);
    }
  }

  const sortedRounds = Array.from(byRound.keys()).sort((a, b) => a - b);
  let cumulative = 0;
  const metrics: RoundMetric[] = [];
  for (const round of sortedRounds) {
    const raw = byRound.get(round) ?? null;
    const signed = raw ?? 0;
    cumulative += signed;
    metrics.push({
      round,
      movement: Math.abs(signed),
      cumulative: Number(cumulative.toFixed(4)),
      hasDelta: raw !== null,
    });
  }
  return metrics;
}

// ---------------------------------------------------------------------------
// Sparkline
// ---------------------------------------------------------------------------

interface SparklineProps {
  metrics: readonly RoundMetric[];
  width?: number;
  height?: number;
}

/**
 * Inline SVG line chart of cumulative confidence movement. Auto-scales the
 * Y axis to the data range so a flat or near-flat series still renders as a
 * visible mid-line rather than a hidden trace pinned to the floor.
 */
function Sparkline({ metrics, width = 280, height = 56 }: SparklineProps) {
  if (metrics.length === 0) {
    return (
      <p className="text-2xs text-zinc-600">No rounds recorded yet.</p>
    );
  }

  const values = metrics.map((m) => m.cumulative);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min;
  const pad = 4;
  const xStep =
    metrics.length > 1 ? (width - pad * 2) / (metrics.length - 1) : 0;
  const yScale = (v: number): number => {
    if (range === 0) return height / 2;
    const t = (v - min) / range;
    return height - pad - t * (height - pad * 2);
  };

  const points = metrics.map((m, i) => {
    const x = pad + i * xStep;
    const y = yScale(m.cumulative);
    return { x, y, value: m.cumulative, round: m.round };
  });
  const path = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)},${p.y.toFixed(2)}`)
    .join(' ');

  // When there's only one round, draw a single dot so the trace is visible.
  const single = metrics.length === 1;
  const last = points[points.length - 1]!;

  return (
    <svg
      role="img"
      aria-label={`Cumulative convergence_delta sparkline across ${metrics.length} round${metrics.length === 1 ? '' : 's'}`}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="block max-w-full"
    >
      <title>Cumulative convergence_delta — research term: convergence_delta running sum</title>
      {/* Baseline */}
      <line
        x1={pad}
        x2={width - pad}
        y1={height - pad}
        y2={height - pad}
        stroke="rgba(255,255,255,0.06)"
        strokeWidth={1}
      />
      {!single && (
        <path
          d={path}
          fill="none"
          stroke="rgb(125 211 252 / 0.7)"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
      <circle
        cx={last.x}
        cy={last.y}
        r={2.5}
        fill="rgb(125 211 252)"
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Disagreement-remaining bar chart
// ---------------------------------------------------------------------------

interface BarChartProps {
  metrics: readonly RoundMetric[];
  width?: number;
  height?: number;
}

/**
 * Inline SVG bar chart of |convergence_delta| per round. Bars share a
 * baseline; max bar reaches `height - pad`. The plain-language label
 * ("Disagreement remaining") sits above the chart; the research term
 * ("residue of conflict") is in the title/aria so screen readers + tooltips
 * surface it without cluttering the visual.
 */
function DisagreementBars({ metrics, width = 280, height = 56 }: BarChartProps) {
  if (metrics.length === 0) {
    return <p className="text-2xs text-zinc-600">No rounds recorded yet.</p>;
  }

  const values = metrics.map((m) => m.movement);
  const max = Math.max(...values, 0);
  const pad = 4;
  const innerW = width - pad * 2;
  const slot = innerW / metrics.length;
  const barW = Math.max(2, slot * 0.7);

  const bars = metrics.map((m, i) => {
    const ratio = max === 0 ? 0 : m.movement / max;
    const h = ratio * (height - pad * 2);
    const x = pad + i * slot + (slot - barW) / 2;
    const y = height - pad - h;
    return { x, y, h, w: barW, round: m.round, movement: m.movement };
  });

  return (
    <svg
      role="img"
      aria-label={`Disagreement remaining (residue of conflict) per round across ${metrics.length} round${metrics.length === 1 ? '' : 's'}`}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="block max-w-full"
    >
      <title>Disagreement remaining — research term: residue of conflict (per-round proxy from |convergence_delta|)</title>
      <line
        x1={pad}
        x2={width - pad}
        y1={height - pad}
        y2={height - pad}
        stroke="rgba(255,255,255,0.06)"
        strokeWidth={1}
      />
      {bars.map((b) => (
        <rect
          key={b.round}
          x={b.x}
          y={b.y}
          width={b.w}
          height={b.h}
          rx={1.5}
          fill="rgb(251 191 36 / 0.45)"
        >
          <title>{`Round ${b.round}: |Δ| = ${b.movement.toFixed(3)}`}</title>
        </rect>
      ))}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Event list
// ---------------------------------------------------------------------------

const EVENT_KIND_LABEL: Record<string, string> = {
  'red_agent.injection': 'Devil-advocate injection',
  'sentry.echo': 'Echo-collapse warning',
  round_start: 'Round start',
  round_end: 'Round end',
  parallel_block_start: 'Parallel block start',
  parallel_block_end: 'Parallel block end',
  synthesis_attempt: 'Synthesis attempt',
  consensus_reached: 'Consensus reached',
  termination: 'Deliberation ended',
};

function eventKindLabel(kind: string | undefined): string {
  if (!kind) return 'Event';
  return EVENT_KIND_LABEL[kind] ?? kind;
}

function EventList({ events }: { events: readonly SystemEvent[] }) {
  if (events.length === 0) {
    return (
      <div
        role="status"
        className="rounded-lg border border-dashed border-white/[0.06] bg-white/[0.01] px-4 py-6 text-center"
      >
        <p className="text-xs font-medium text-zinc-500">No interventions</p>
        <p className="mt-1 text-2xs text-zinc-600">
          No devil-advocate injections or echo-collapse warnings fired during this deliberation.
        </p>
      </div>
    );
  }

  return (
    <ul className="space-y-1.5">
      {events.map((ev, i) => {
        const round = typeof ev.round === 'number' ? ev.round : null;
        const kind = ev.kind ?? 'unknown';
        const message = ev.message ?? '(no description)';
        return (
          <li
            key={`${kind}-${round ?? 'x'}-${i}`}
            className="flex items-start gap-2 rounded-md bg-white/[0.02] px-3 py-2 text-2xs"
          >
            <span
              className="mt-0.5 inline-flex shrink-0 items-center rounded bg-white/[0.04] px-1.5 py-0.5 font-mono text-2xs text-zinc-400"
              title={`research kind: ${kind}`}
            >
              {round !== null ? `R${round}` : '—'}
            </span>
            <div className="min-w-0 flex-1">
              <p className="font-medium text-zinc-300">
                {eventKindLabel(kind)}
              </p>
              <p className="mt-0.5 break-words text-zinc-500">{message}</p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

interface PanelBodyProps {
  result: DeliberationResult;
}

function PanelBody({ result }: PanelBodyProps) {
  const metrics = useMemo(() => buildRoundMetrics(result.turns), [result.turns]);
  const events = result.events ?? [];

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <section
        aria-label="Confidence sparkline (convergence_delta cumulative)"
        className="rounded-lg bg-white/[0.02] p-3 ring-1 ring-white/[0.04]"
      >
        <header className="mb-2 flex items-baseline justify-between">
          <h4 className="text-2xs font-semibold uppercase tracking-wider text-zinc-400">
            Room movement
          </h4>
          <span
            className="font-mono text-2xs text-zinc-600"
            title="research metric: convergence_delta cumulative"
          >
            {metrics.length} round{metrics.length === 1 ? '' : 's'}
          </span>
        </header>
        <Sparkline metrics={metrics} />
      </section>

      <section
        aria-label="Disagreement remaining (residue of conflict)"
        className="rounded-lg bg-white/[0.02] p-3 ring-1 ring-white/[0.04]"
      >
        <header className="mb-2 flex items-baseline justify-between">
          <h4 className="text-2xs font-semibold uppercase tracking-wider text-zinc-400">
            Disagreement remaining
          </h4>
          <span
            className="font-mono text-2xs text-zinc-600"
            title="research metric: residue of conflict (per-round proxy)"
          >
            final residue {result.residueScore.toFixed(2)}
          </span>
        </header>
        <DisagreementBars metrics={metrics} />
      </section>

      <section
        aria-label="System events (RedAgent injections, Sentry warnings, lifecycle markers)"
        className="rounded-lg bg-white/[0.02] p-3 ring-1 ring-white/[0.04] md:col-span-2"
      >
        <header className="mb-2 flex items-baseline justify-between">
          <h4 className="text-2xs font-semibold uppercase tracking-wider text-zinc-400">
            Interventions
          </h4>
          <span
            className="font-mono text-2xs text-zinc-600"
            title="research metric: events[] stream (red_agent.injection, sentry.echo, lifecycle)"
          >
            {events.length} event{events.length === 1 ? '' : 's'}
          </span>
        </header>
        <EventList events={events} />
      </section>
    </div>
  );
}

export interface ObservabilityPanelProps {
  result: DeliberationResult | null;
  /** Controlled-open flag. The Timeline header owns the toggle state. */
  open: boolean;
}

/**
 * Mounts under the Timeline header. When `open` is false, returns null so the
 * panel takes zero visual real estate. When open with no result yet, renders
 * a friendly empty card instead of a broken chart.
 */
export function ObservabilityPanel({ result, open }: ObservabilityPanelProps) {
  if (!open) return null;

  return (
    <div
      data-testid="observability-panel"
      className="rounded-xl bg-white/[0.015] p-4 ring-1 ring-white/[0.05]"
    >
      <div className="mb-3 flex items-baseline justify-between">
        <h3 className="text-2xs font-semibold uppercase tracking-widest text-zinc-500">
          Observability
        </h3>
        <span
          className="text-2xs text-zinc-600"
          title="Inspection view — research metrics surfaced in tooltips and aria-labels."
        >
          inspection view
        </span>
      </div>
      {result ? (
        <PanelBody result={result} />
      ) : (
        <p className="rounded-lg border border-dashed border-white/[0.06] bg-white/[0.01] px-4 py-6 text-center text-2xs text-zinc-600">
          Run a deliberation to see room movement, disagreement levels, and intervention events.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Toggle button — mounted by Timeline in its header.
// ---------------------------------------------------------------------------

export interface ObservabilityToggleProps {
  open: boolean;
  onToggle: () => void;
}

export function ObservabilityToggle({ open, onToggle }: ObservabilityToggleProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-controls="observability-panel"
      className={`flex h-7 items-center gap-1.5 rounded-md px-2 text-2xs font-medium ring-1 transition-colors ${
        open
          ? 'bg-white/[0.06] text-zinc-200 ring-white/[0.1]'
          : 'bg-white/[0.02] text-zinc-400 ring-white/[0.06] hover:bg-white/[0.04] hover:text-zinc-200'
      }`}
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
      >
        <path
          d="M3 12h4l3-9 4 18 3-9h4"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      {open ? 'Hide observability' : 'Show observability'}
    </button>
  );
}

