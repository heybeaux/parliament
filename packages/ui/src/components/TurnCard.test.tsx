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
