/**
 * PAR-3 — Stage 3 turn-card enrichment.
 *
 * Each test exercises one of the three rendering modes the ticket calls out:
 *   1. Enriched turn → all four PAR-10 fields visible.
 *   2. Round-1 turn → `convergence_delta: null` renders as `—` (em-dash),
 *      not `+null` and not silently hidden.
 *   3. Legacy / pre-Stage-3 turn → no enrichment fields, no enrichment row,
 *      no NaN, no missing-prop warnings.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { TurnCard } from './TurnCard';
import type { Turn } from '../lib/types';

const BASE_TURN: Turn = {
  agent: 'proposer',
  neurotype: 'empiricist',
  model: 'mistral-7b-openorca',
  content: 'A grounded position based on the evidence so far.',
  timestamp: '2026-04-30T12:00:00Z',
  round: 2,
};

describe('TurnCard — Stage 3 enrichment (PAR-3)', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders all four enrichment fields when the server supplies them', () => {
    const enriched: Turn = {
      ...BASE_TURN,
      model_name: 'mistral-7b-openorca',
      neurotype_posture: 'evidence-first',
      word_count: 142,
      convergence_delta: 0.12,
    };

    render(<TurnCard turn={enriched} index={0} />);
    const row = screen.getByTestId('turn-enrichment');

    // Plain-language posture label visible to the user; underlying
    // neurotype ID is exposed only via tooltip / aria-label.
    expect(within(row).getByText('evidence-first')).toBeInTheDocument();
    expect(within(row).queryByText('empiricist')).not.toBeInTheDocument();

    // Model name surfaces in the secondary line (the header keeps the
    // legacy `model` rendering — both can coexist; we only assert the
    // enrichment row contains the wire-stable `model_name`).
    expect(within(row).getByText('mistral-7b-openorca')).toBeInTheDocument();

    // Word count rendered with plain-language unit; research term lives
    // in the title / aria-label.
    expect(within(row).getByText('142 words')).toBeInTheDocument();
    const wordChip = within(row).getByLabelText(/word count: 142/i);
    expect(wordChip).toHaveAttribute('title', 'word_count');

    // Sign-aware delta with explicit `+` for convergence-toward-consensus.
    const deltaChip = within(row).getByText('+0.12');
    expect(deltaChip).toBeInTheDocument();
    expect(deltaChip).toHaveAttribute('title', 'convergence_delta');
    expect(deltaChip.getAttribute('aria-label')).toMatch(/toward consensus/i);
  });

  it('renders convergence_delta: null as "—" (em-dash) on round-1 turns', () => {
    const roundOne: Turn = {
      ...BASE_TURN,
      round: 1,
      model_name: 'mistral-7b-openorca',
      neurotype_posture: 'evidence-first',
      word_count: 88,
      convergence_delta: null,
    };

    render(<TurnCard turn={roundOne} index={0} />);
    const row = screen.getByTestId('turn-enrichment');

    // Em-dash, not "+null" and not silently dropped.
    expect(within(row).getByText('—')).toBeInTheDocument();
    expect(within(row).queryByText(/null/i)).not.toBeInTheDocument();
    expect(within(row).queryByText(/NaN/i)).not.toBeInTheDocument();

    // The other three enrichment fields still render.
    expect(within(row).getByText('mistral-7b-openorca')).toBeInTheDocument();
    expect(within(row).getByText('evidence-first')).toBeInTheDocument();
    expect(within(row).getByText('88 words')).toBeInTheDocument();

    // Aria-label communicates "not measurable yet" so screen readers don't
    // hear a bare em-dash.
    const deltaChip = within(row).getByText('—');
    expect(deltaChip.getAttribute('aria-label')).toMatch(/not measurable/i);
  });

  it('renders sign-aware "−" minus for convergence away from consensus', () => {
    const diverging: Turn = {
      ...BASE_TURN,
      model_name: 'mistral-7b-openorca',
      neurotype_posture: 'adversarial',
      word_count: 64,
      convergence_delta: -0.08,
    };

    render(<TurnCard turn={diverging} index={0} />);
    const row = screen.getByTestId('turn-enrichment');

    // Unicode minus (U+2212), not ASCII hyphen-minus.
    expect(within(row).getByText('\u22120.08')).toBeInTheDocument();
  });

  it('renders pre-Stage-3 turns unchanged: no enrichment row, no NaN', () => {
    // Legacy turn shape — none of the PAR-10 fields are present.
    const legacy: Turn = { ...BASE_TURN };

    render(<TurnCard turn={legacy} index={0} />);

    // Enrichment row is absent entirely.
    expect(screen.queryByTestId('turn-enrichment')).not.toBeInTheDocument();

    // No spurious tokens leak into the DOM.
    expect(screen.queryByText(/NaN/)).not.toBeInTheDocument();
    expect(screen.queryByText('—')).not.toBeInTheDocument();
    expect(screen.queryByText(/null/)).not.toBeInTheDocument();

    // Legacy header still renders the original agent label + model line.
    expect(screen.getByText('Proposer')).toBeInTheDocument();
    expect(screen.getByText('mistral-7b-openorca')).toBeInTheDocument();
  });
});

/**
 * PAR-24 — per-turn meta footer (latency / tokens / cost / provider).
 *
 * The footer sits beneath the existing time/OSI row and shows whatever
 * telemetry the adapter produced for this turn. Each chip renders
 * independently so a fully-local turn (no cost) collapses the cost chip
 * while keeping latency + tokens, and a pre-PAR-23 turn (no `meta` at
 * all) collapses the row entirely.
 */
describe('TurnCard — PAR-24 meta footer', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders all four meta chips when meta has every field', () => {
    const fullMeta: Turn = {
      ...BASE_TURN,
      meta: {
        latencyMs: 1234,
        promptTokens: 420,
        completionTokens: 180,
        costUsd: 0.0042,
        provider: 'openrouter',
      },
    };

    render(<TurnCard turn={fullMeta} index={0} />);
    const row = screen.getByTestId('turn-meta');

    // 1234ms → 1.2s (single-decimal seconds for >= 1000ms).
    expect(within(row).getByText('1.2s')).toBeInTheDocument();
    // Tokens render with a Unicode arrow between prompt and completion.
    expect(within(row).getByText(/420\s*\u2192\s*180/)).toBeInTheDocument();
    // Cost rendered to 4 decimal places with a leading `$`.
    expect(within(row).getByText('$0.0042')).toBeInTheDocument();
    // Provider chip is plain text.
    expect(within(row).getByText('openrouter')).toBeInTheDocument();
  });

  it('renders no meta row when the turn omits `meta` entirely', () => {
    const noMeta: Turn = { ...BASE_TURN };

    render(<TurnCard turn={noMeta} index={0} />);

    expect(screen.queryByTestId('turn-meta')).not.toBeInTheDocument();
  });

  it('renders no meta row when `meta` is present but every field is missing', () => {
    // The engine could in theory write an empty meta object (e.g. a
    // synthesizer turn whose adapter ran but reported no telemetry).
    // Since none of the four chips have data, the row should hide.
    const emptyMeta: Turn = { ...BASE_TURN, meta: {} };

    render(<TurnCard turn={emptyMeta} index={0} />);

    expect(screen.queryByTestId('turn-meta')).not.toBeInTheDocument();
  });

  it('shows the cost chip on an OpenRouter turn', () => {
    const openrouter: Turn = {
      ...BASE_TURN,
      meta: {
        latencyMs: 2500,
        promptTokens: 300,
        completionTokens: 120,
        costUsd: 0.0042,
        provider: 'openrouter',
      },
    };

    render(<TurnCard turn={openrouter} index={0} />);
    const row = screen.getByTestId('turn-meta');

    expect(within(row).getByText('$0.0042')).toBeInTheDocument();
    expect(within(row).getByText('openrouter')).toBeInTheDocument();
  });

  it('hides the cost chip on a local omlx turn (no costUsd)', () => {
    const omlx: Turn = {
      ...BASE_TURN,
      meta: {
        latencyMs: 800,
        promptTokens: 250,
        completionTokens: 90,
        provider: 'omlx',
        // costUsd intentionally omitted — local providers don't report cost.
      },
    };

    render(<TurnCard turn={omlx} index={0} />);
    const row = screen.getByTestId('turn-meta');

    // Provider, latency, tokens still render.
    expect(within(row).getByText('omlx')).toBeInTheDocument();
    expect(within(row).getByText('800ms')).toBeInTheDocument();
    expect(within(row).getByText(/250\s*\u2192\s*90/)).toBeInTheDocument();
    // No cost chip — i.e. nothing matching the `$N.NNNN` pattern.
    expect(within(row).queryByText(/^\$\d+\.\d{4}$/)).toBeNull();
  });

  it('renders the token chip only when both promptTokens and completionTokens are present', () => {
    // Only promptTokens — no token chip.
    const promptOnly: Turn = {
      ...BASE_TURN,
      meta: { promptTokens: 500, provider: 'openrouter' },
    };
    const { unmount } = render(<TurnCard turn={promptOnly} index={0} />);
    const row = screen.getByTestId('turn-meta');
    // Provider still renders, but no `N → N` arrow.
    expect(within(row).getByText('openrouter')).toBeInTheDocument();
    expect(within(row).queryByText(/\u2192/)).toBeNull();
    unmount();

    // Only completionTokens — no token chip.
    const completionOnly: Turn = {
      ...BASE_TURN,
      meta: { completionTokens: 200, provider: 'openrouter' },
    };
    render(<TurnCard turn={completionOnly} index={0} />);
    const row2 = screen.getByTestId('turn-meta');
    expect(within(row2).queryByText(/\u2192/)).toBeNull();
  });

  it('formats sub-1000ms latency in `ms` and >=1000ms in `Ns`', () => {
    const fast: Turn = { ...BASE_TURN, meta: { latencyMs: 250 } };
    const { unmount } = render(<TurnCard turn={fast} index={0} />);
    expect(within(screen.getByTestId('turn-meta')).getByText('250ms')).toBeInTheDocument();
    unmount();

    const slow: Turn = { ...BASE_TURN, meta: { latencyMs: 12500 } };
    render(<TurnCard turn={slow} index={0} />);
    expect(within(screen.getByTestId('turn-meta')).getByText('12.5s')).toBeInTheDocument();
  });
});
