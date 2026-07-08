import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
function stubFetchSequence(
  deliberations: unknown[],
  transcripts: unknown[] = [],
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = typeof input === 'string' ? input : (input as { url: string }).url;
    if (url.endsWith('/deliberations')) {
      return new Response(JSON.stringify({ deliberations }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.endsWith('/transcripts')) {
      return new Response(JSON.stringify({ transcripts }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('{}', { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Newest-first summaries the way the server returns them. */
function makeDeliberations(count: number): unknown[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `d-${i}`,
    topic: `Deliberation topic ${i}`,
    created_at: new Date(Date.now() - i * 60_000).toISOString(),
    resolved: 1,
    total_rounds: 2,
    termination_reason: 'consensus',
    preset: 'debate',
  }));
}

function makeTranscripts(count: number): unknown[] {
  return Array.from({ length: count }, (_, i) => ({
    file: `transcript-${i}.json`,
    topic: `Transcript topic ${i}`,
    created_at: new Date(Date.now() - i * 60_000).toISOString(),
  }));
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

// ---------------------------------------------------------------------------
// Pagination — a 230-item history must not render all at once. The newest 15
// show per tab, "Show more" reveals 15 more, and a "Showing X of Y" hint
// keeps the total visible. The visible count resets on tab switch and on
// refreshKey change.
// ---------------------------------------------------------------------------

describe('TranscriptList — pagination', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows only the newest 15 of 40 with a "Showing 15 of 40" hint', async () => {
    stubFetchSequence(makeDeliberations(40));
    render(
      <TranscriptList refreshKey={0} onLoadDeliberation={() => {}} onLoadTranscript={() => {}} />,
    );

    await waitFor(() => {
      expect(screen.getAllByTestId('preset-badge')).toHaveLength(15);
    });
    // Newest first: item 0 visible, item 15 not.
    expect(screen.getByText('Deliberation topic 0')).toBeInTheDocument();
    expect(screen.queryByText('Deliberation topic 15')).not.toBeInTheDocument();
    expect(screen.getByText('Showing 15 of 40')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show more' })).toBeInTheDocument();
  });

  it('reveals 15 more per "Show more" click and hides the button at the end', async () => {
    const user = userEvent.setup();
    stubFetchSequence(makeDeliberations(40));
    render(
      <TranscriptList refreshKey={0} onLoadDeliberation={() => {}} onLoadTranscript={() => {}} />,
    );
    await waitFor(() => {
      expect(screen.getAllByTestId('preset-badge')).toHaveLength(15);
    });

    await user.click(screen.getByRole('button', { name: 'Show more' }));
    await waitFor(() => {
      expect(screen.getAllByTestId('preset-badge')).toHaveLength(30);
    });
    expect(screen.getByText('Showing 30 of 40')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Show more' }));
    await waitFor(() => {
      expect(screen.getAllByTestId('preset-badge')).toHaveLength(40);
    });
    expect(screen.getByText('Showing 40 of 40')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show more' })).not.toBeInTheDocument();
  });

  it('does not paginate short lists (no hint, no button)', async () => {
    stubFetchSequence(makeDeliberations(3));
    render(
      <TranscriptList refreshKey={0} onLoadDeliberation={() => {}} onLoadTranscript={() => {}} />,
    );
    await waitFor(() => {
      expect(screen.getAllByTestId('preset-badge')).toHaveLength(3);
    });
    expect(screen.queryByText(/Showing \d+ of \d+/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show more' })).not.toBeInTheDocument();
  });

  it('paginates the Transcripts tab and resets the count on tab switch', async () => {
    const user = userEvent.setup();
    stubFetchSequence(makeDeliberations(40), makeTranscripts(20));
    render(
      <TranscriptList refreshKey={0} onLoadDeliberation={() => {}} onLoadTranscript={() => {}} />,
    );
    await waitFor(() => {
      expect(screen.getAllByTestId('preset-badge')).toHaveLength(15);
    });

    // Expand the deliberations tab past one page…
    await user.click(screen.getByRole('button', { name: 'Show more' }));
    await waitFor(() => {
      expect(screen.getAllByTestId('preset-badge')).toHaveLength(30);
    });

    // …switch to Transcripts: back to one page (of transcripts).
    await user.click(screen.getByRole('button', { name: /Transcripts \(20\)/ }));
    await waitFor(() => {
      expect(screen.getByText('Showing 15 of 20')).toBeInTheDocument();
    });
    expect(screen.getByText('Transcript topic 0')).toBeInTheDocument();
    expect(screen.queryByText('Transcript topic 15')).not.toBeInTheDocument();

    // Switching back to Stored resets its count to one page too.
    await user.click(screen.getByRole('button', { name: /Stored \(40\)/ }));
    await waitFor(() => {
      expect(screen.getAllByTestId('preset-badge')).toHaveLength(15);
    });
    expect(screen.getByText('Showing 15 of 40')).toBeInTheDocument();
  });

  it('resets the visible count when refreshKey changes', async () => {
    const user = userEvent.setup();
    stubFetchSequence(makeDeliberations(40));
    const { rerender } = render(
      <TranscriptList refreshKey={0} onLoadDeliberation={() => {}} onLoadTranscript={() => {}} />,
    );
    await waitFor(() => {
      expect(screen.getAllByTestId('preset-badge')).toHaveLength(15);
    });

    await user.click(screen.getByRole('button', { name: 'Show more' }));
    await waitFor(() => {
      expect(screen.getAllByTestId('preset-badge')).toHaveLength(30);
    });

    rerender(
      <TranscriptList refreshKey={1} onLoadDeliberation={() => {}} onLoadTranscript={() => {}} />,
    );
    await waitFor(() => {
      expect(screen.getAllByTestId('preset-badge')).toHaveLength(15);
    });
    expect(screen.getByText('Showing 15 of 40')).toBeInTheDocument();
  });
});
