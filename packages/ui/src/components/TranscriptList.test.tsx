import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { TranscriptList } from './TranscriptList';

/**
 * PAR-20 — load-bearing acceptance test from the ticket: a list of three
 * deliberations on the same topic across three different presets must
 * render three visually distinct preset badges so the user can tell them
 * apart at a glance without clicking through.
 *
 * We also pin the legacy fallback contract: a deliberation summary missing
 * the `preset` field (i.e. a row recorded before PAR-20 landed) renders the
 * neutral em-dash badge instead of crashing or logging a missing-prop
 * warning.
 */
function stubFetchSequence(deliberations: unknown[]): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = typeof input === 'string' ? input : (input as { url: string }).url;
    if (url.endsWith('/deliberations')) {
      return new Response(JSON.stringify({ deliberations }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.endsWith('/transcripts')) {
      return new Response(JSON.stringify({ transcripts: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('{}', { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('TranscriptList — preset badges', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders 3 visually distinct badges for the same topic across 3 presets', async () => {
    const SAME_TOPIC = 'Should Parliament adopt feature flags?';
    stubFetchSequence([
      {
        id: 'a',
        topic: SAME_TOPIC,
        created_at: new Date().toISOString(),
        resolved: 1,
        total_rounds: 2,
        termination_reason: 'consensus',
        preset: 'debate',
      },
      {
        id: 'b',
        topic: SAME_TOPIC,
        created_at: new Date().toISOString(),
        resolved: 0,
        total_rounds: 3,
        termination_reason: 'max_rounds',
        preset: 'star-chamber',
      },
      {
        id: 'c',
        topic: SAME_TOPIC,
        created_at: new Date().toISOString(),
        resolved: 1,
        total_rounds: 2,
        termination_reason: 'consensus',
        preset: 'jury',
      },
    ]);

    render(
      <TranscriptList
        refreshKey={0}
        onLoadDeliberation={() => {}}
        onLoadTranscript={() => {}}
      />,
    );

    // All three rows render — same topic, different presets.
    await waitFor(() => {
      expect(screen.getAllByTestId('preset-badge')).toHaveLength(3);
    });

    const badges = screen.getAllByTestId('preset-badge');
    const presetIds = badges.map((b) => b.getAttribute('data-preset-id'));
    expect(presetIds).toEqual(['debate', 'star-chamber', 'jury']);

    // Pull the dot color class off each badge — three different hues.
    const dotColors = badges.map((b) => {
      const dot = b.querySelector('[aria-hidden="true"]');
      // The dot has multiple classes; the color one starts with `bg-`.
      const classes = dot?.className.split(/\s+/) ?? [];
      return classes.find((c) => c.startsWith('bg-')) ?? '';
    });
    // Sanity — every badge has a color class, and they are pairwise distinct.
    expect(dotColors.every((c) => c !== '')).toBe(true);
    expect(new Set(dotColors).size).toBe(3);

    // Plain-language labels are present, not kebab-case ids.
    expect(badges[0]).toHaveTextContent(/^debate$/i);
    expect(badges[1]).toHaveTextContent(/star chamber/i);
    expect(badges[2]).toHaveTextContent(/^jury$/i);
  });

  it('renders the neutral em-dash badge for legacy summaries with no preset field', async () => {
    stubFetchSequence([
      {
        id: 'legacy-1',
        topic: 'Pre-PAR-20 deliberation',
        created_at: new Date().toISOString(),
        resolved: 1,
        total_rounds: 1,
        termination_reason: 'consensus',
        // preset intentionally omitted
      },
      {
        id: 'legacy-2',
        topic: 'Another pre-PAR-20',
        created_at: new Date().toISOString(),
        resolved: 0,
        total_rounds: 2,
        termination_reason: 'max_rounds',
        preset: null,
      },
    ]);

    // Capture console.error so we can assert no missing-prop warning fires.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <TranscriptList
        refreshKey={0}
        onLoadDeliberation={() => {}}
        onLoadTranscript={() => {}}
      />,
    );

    await waitFor(() => {
      expect(screen.getAllByTestId('preset-badge')).toHaveLength(2);
    });

    for (const badge of screen.getAllByTestId('preset-badge')) {
      expect(badge).toHaveTextContent('\u2014');
    }
    // No React warnings triggered by the legacy / null preset id.
    expect(errorSpy).not.toHaveBeenCalled();

    errorSpy.mockRestore();
  });
});
