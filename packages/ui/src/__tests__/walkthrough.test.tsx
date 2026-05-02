/**
 * PAR-6 — Stage 3 UI walkthrough.
 *
 * One end-to-end component test that exercises the full Stage 3 user-visible
 * flow against mocked HTTP. It is the closer for Stage 3 — without it,
 * regressions in any of PAR-2 (preset picker), PAR-3 (turn enrichment
 * badges), PAR-4 (parallel siblings), or PAR-5 (observability panel) only
 * surface in manual smoke testing.
 *
 * Flow:
 *   1. Mount the app with the picker visible.
 *   2. Mock `GET /api/presets` returning Debate, Jury, and Star Chamber, with
 *      `defaultPreset = 'debate'`.
 *   3. Open the picker and select Jury.
 *   4. Submit a topic.
 *   5. Mock `POST /api/deliberate` returning `{id, status: 'in_flight'}` (the
 *      PAR-18 contract). Drive the canned 3-round Jury transcript through a
 *      fake `EventSource` (PAR-26 — the App opens an SSE stream once it
 *      knows the id), terminate with `event: status` `'completed'`. After
 *      terminal the hook fetches `GET /deliberate/:id` once for the
 *      canonical snapshot — that returns the full canned transcript.
 *
 * Asserts:
 *   - PresetPicker shows three options.
 *   - Jury becomes selected (chip + select option).
 *   - Parallel siblings render as a row (PAR-4 — `parallel_group` field).
 *   - Posture / word-count / convergence-delta / model-name badges appear on
 *     the right turns (PAR-3).
 *   - Observability panel toggles open and shows the RedAgent event (PAR-5).
 *   - Final rendered DOM matches a committed snapshot (regression net).
 *
 * The `FakeEventSource` mirrors the one in `App.test.tsx` /
 * `useDeliberationStream.test.tsx` so the streaming-hook contract is the
 * same one those tests pin.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../App';
import { ACTIVE_DELIBERATION_KEY } from '../lib/activeDeliberation';
import juryTranscript from '../../test/fixtures/jury-transcript.json';

// ---------------------------------------------------------------------------
// Snapshot stability — strip framer-motion's per-frame inline animation
// styles so re-runs produce a deterministic DOM. The animation is mid-flight
// when we sample (opacity / transform interpolating between keyframes), so
// the only thing that drifts between runs is those numeric values; class
// names, structure, ARIA, data-* attrs all stay stable.
//
// We deep-clone the rendered DOM, walk every element, and rewrite any
// `style="opacity:...; transform: translateY(...)..."` pair to a fixed
// sentinel before passing to `toMatchSnapshot`. The committed snapshot keeps
// the marker so structural regressions are still caught — only the noisy
// numbers are elided.
// ---------------------------------------------------------------------------

const FRAMER_STYLE_RE = /opacity:\s*[\d.]+(?:;\s*transform:\s*[^";]+)?/i;

function stripFramerMotionInlineStyles(root: HTMLElement): HTMLElement {
  const clone = root.cloneNode(true) as HTMLElement;
  const styled = clone.querySelectorAll<HTMLElement>('[style]');
  for (const el of styled) {
    const style = el.getAttribute('style');
    if (style && FRAMER_STYLE_RE.test(style)) {
      el.setAttribute('style', '<<framer-motion>>');
    }
  }
  return clone;
}

// ---------------------------------------------------------------------------
// Fixture data — server responses
// ---------------------------------------------------------------------------

const PRESETS_RESPONSE = {
  presets: [
    {
      id: 'debate',
      name: 'Debate',
      description: 'Proposer vs. Skeptic with a Synthesizer reconciling.',
      best_for: 'Open-ended questions where competing positions need airing.',
    },
    {
      id: 'jury',
      name: 'Jury',
      description: 'Parallel independent panel votes; results merged in order.',
      best_for: 'When breadth of independent opinion matters more than dialogue.',
    },
    {
      id: 'star-chamber',
      name: 'Star Chamber',
      description: 'Adversarial panel pressure-tests the proposal.',
      best_for: 'High-stakes decisions that benefit from hostile review.',
    },
  ],
  defaultPreset: 'debate',
};

const HEALTH_RESPONSE = {
  status: 'ok',
  models: { 'mock-model': 'connected' as const },
};

const ACCEPTED_ID = 'walkthrough-deliberation-id';

// ---------------------------------------------------------------------------
// Fake EventSource — drives PAR-26 SSE handling without a real socket.
// Matches the shape used in `App.test.tsx` so the contract is consistent.
// ---------------------------------------------------------------------------

interface FakeEventSourceHandle {
  url: string;
  closed: boolean;
  emit: (event: string, payload: unknown) => void;
}

const fakeHandles: FakeEventSourceHandle[] = [];

class FakeEventSource {
  private listeners = new Map<string, ((ev: MessageEvent) => void)[]>();
  public onerror: (() => void) | null = null;
  public closed = false;

  constructor(public url: string) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    fakeHandles.push({
      url,
      get closed() {
        return self.closed;
      },
      set closed(v: boolean) {
        self.closed = v;
      },
      emit: (event, payload) => {
        const list = self.listeners.get(event) ?? [];
        const message = {
          data: typeof payload === 'string' ? payload : JSON.stringify(payload),
        } as MessageEvent;
        for (const fn of list) fn(message);
      },
    });
  }

  addEventListener(name: string, handler: (ev: MessageEvent) => void): void {
    const list = this.listeners.get(name) ?? [];
    list.push(handler);
    this.listeners.set(name, list);
  }

  close(): void {
    this.closed = true;
  }
}

// ---------------------------------------------------------------------------
// Fetch stub — covers every endpoint App + its children touch.
// ---------------------------------------------------------------------------

function installFetchMock(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    const method = init?.method ?? (typeof input !== 'string' ? (input as Request).method : 'GET');

    if (url.includes('/api/presets')) {
      return jsonResponse(PRESETS_RESPONSE);
    }
    if (url.includes('/api/health')) {
      return jsonResponse(HEALTH_RESPONSE);
    }
    if (url.includes('/api/deliberations')) {
      return jsonResponse({ deliberations: [] });
    }
    if (url.includes('/api/transcripts')) {
      return jsonResponse({ transcripts: [] });
    }
    if (url.endsWith('/api/deliberate') && method?.toUpperCase() === 'POST') {
      // PAR-18 contract — return 202-equivalent body. Status code is 200
      // because the UI's `jsonOrThrow` only checks `res.ok`, and we never
      // distinguish 200 vs. 202 client-side.
      return jsonResponse({ id: ACCEPTED_ID, status: 'in_flight' });
    }
    if (/\/api\/deliberate\/[^/]+$/.test(url)) {
      // Canonical snapshot fetched after the SSE stream emits terminal.
      return jsonResponse(juryTranscript);
    }
    // Default — empty success so a stray request never explodes the test.
    return jsonResponse({});
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : status === 202 ? 'Accepted' : 'Error',
    json: async () => body,
    text: async () => '',
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe('PAR-6 — Stage 3 UI walkthrough', () => {
  beforeEach(() => {
    fakeHandles.length = 0;
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it('walks PresetPicker → Timeline (parallel siblings + enrichment) → Observability', async () => {
    installFetchMock();
    vi.stubGlobal('EventSource', FakeEventSource);

    const user = userEvent.setup();
    const { container } = render(<App />);

    // -------------------------------------------------------------------
    // PAR-2 — PresetPicker
    // -------------------------------------------------------------------

    // Wait for /presets to resolve and the three options to be wired up.
    const select = (await screen.findByLabelText(
      /deliberation preset/i,
    )) as HTMLSelectElement;
    await waitFor(() => {
      expect(select.options.length).toBe(3);
    });

    // All three preset names render.
    const optionLabels = Array.from(select.options).map((o) => o.text);
    expect(optionLabels.some((t) => /Debate/.test(t))).toBe(true);
    expect(optionLabels.some((t) => /Jury/.test(t))).toBe(true);
    expect(optionLabels.some((t) => /Star Chamber/.test(t))).toBe(true);

    // Default is `debate` (server-supplied `defaultPreset`).
    await waitFor(() => expect(select.value).toBe('debate'));

    // Open the picker and select Jury.
    await user.selectOptions(select, 'jury');
    expect(select.value).toBe('jury');

    // The "Best for" chip echoes the Jury label — confirms the selected-chip
    // path renders the lime preset color.
    const bestForRow = await screen.findByTestId('preset-best-for');
    expect(bestForRow).toHaveTextContent(/Jury/i);
    // The Jury option in the chip row is `aria-pressed=true`.
    const chipRow = screen.getByTestId('preset-chip-row');
    const juryChip = within(chipRow)
      .getAllByRole('button')
      .find((b) => /Jury/i.test(b.textContent ?? ''));
    expect(juryChip).toBeDefined();
    expect(juryChip!).toHaveAttribute('aria-pressed', 'true');

    // -------------------------------------------------------------------
    // Submit a topic — fires POST /api/deliberate which returns
    // {id, status: 'in_flight'}, then opens the SSE stream.
    // -------------------------------------------------------------------

    const topicInput = screen.getByPlaceholderText(/Should an autonomous AI/i);
    await user.type(topicInput, juryTranscript.topic);

    const submitBtn = screen.getByRole('button', { name: /^deliberate$/i });
    await user.click(submitBtn);

    // SSE opens at the expected URL.
    await waitFor(() => expect(fakeHandles.length).toBe(1));
    const handle = fakeHandles[0]!;
    expect(handle.url).toBe(`/api/deliberate/${ACCEPTED_ID}/stream`);

    // -------------------------------------------------------------------
    // Stream the canned transcript turns + the RedAgent event over SSE,
    // then terminate. The hook then fetches GET /api/deliberate/:id once
    // for the canonical snapshot — our mock returns the full transcript.
    // -------------------------------------------------------------------

    // Push every turn through the wire in the same order the transcript
    // captured them. Wrap each emit in act() so React flushes between.
    for (const turn of juryTranscript.turns) {
      await act(async () => {
        handle.emit('turn', turn);
      });
    }

    // Push the single RedAgent event so the streaming `events[]` mirrors the
    // canonical snapshot (the canonical fetch will overwrite this anyway,
    // but emitting it exercises the `system_event` SSE branch).
    for (const event of juryTranscript.events) {
      await act(async () => {
        handle.emit('system_event', event);
      });
    }

    // Terminal status — drives the canonical fetch.
    await act(async () => {
      handle.emit('status', { status: 'completed' });
    });

    // Wait for the canonical snapshot to land — the synthesis text is the
    // marker since it only appears in the terminal result.
    await waitFor(() => {
      expect(screen.getByText(juryTranscript.synthesis!)).toBeInTheDocument();
    });

    // The SSE handle is closed.
    expect(handle.closed).toBe(true);

    // -------------------------------------------------------------------
    // PAR-4 — Parallel siblings render as a row, not a stack.
    // -------------------------------------------------------------------

    const parallelRows = screen.getAllByTestId('parallel-row');
    expect(parallelRows).toHaveLength(1);
    const parallelRow = parallelRows[0]!;
    expect(parallelRow).toHaveAttribute('data-parallel-group', 'round-1-jury');
    // Both Round 1 jurors live inside the same parallel row.
    expect(
      within(parallelRow).getByText(/Round 1 Juror A/i),
    ).toBeInTheDocument();
    expect(
      within(parallelRow).getByText(/Round 1 Juror B/i),
    ).toBeInTheDocument();

    // -------------------------------------------------------------------
    // PAR-3 — Enrichment badges (posture, word-count, convergence-delta,
    // model-name) render on turns that carry the fields.
    // -------------------------------------------------------------------

    const enrichmentRows = screen.getAllByTestId('turn-enrichment');
    // Every canned turn carries enrichment fields.
    expect(enrichmentRows.length).toBe(juryTranscript.turns.length);

    // Postures from the fixture all appear somewhere on the page.
    expect(screen.getAllByText(/evidence-first/).length).toBeGreaterThan(0);
    expect(screen.getByText(/adversarial/)).toBeInTheDocument();
    expect(screen.getAllByText(/reconciliation/).length).toBeGreaterThan(0);

    // Word-count badges render with the engine-supplied counts.
    expect(screen.getAllByText(/\d+ words/).length).toBe(
      juryTranscript.turns.length,
    );

    // Convergence-delta badges: round-1 turns render the em-dash (delta is
    // null), later turns render the signed +0.NN value.
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('+0.12')).toBeInTheDocument();
    expect(screen.getByText('+0.18')).toBeInTheDocument();
    expect(screen.getByText('+0.24')).toBeInTheDocument();

    // -------------------------------------------------------------------
    // PAR-5 — Observability panel toggles open and shows the RedAgent event.
    // -------------------------------------------------------------------

    // Closed by default.
    expect(screen.queryByTestId('observability-panel')).toBeNull();

    const observabilityToggle = screen.getByRole('button', {
      name: /show observability/i,
    });
    await user.click(observabilityToggle);

    const panel = await screen.findByTestId('observability-panel');
    // Plain-language label is visible (the section header — not the SVG
    // title that also carries the phrase).
    expect(
      within(panel).getByRole('heading', { name: /Disagreement remaining/i }),
    ).toBeInTheDocument();
    // The RedAgent event lands in the intervention list.
    expect(
      within(panel).getByText(/Devil-advocate injection/i),
    ).toBeInTheDocument();
    expect(
      within(panel).getByText(/rollback channels are themselves compromised/i),
    ).toBeInTheDocument();

    // -------------------------------------------------------------------
    // Visual regression — committed snapshot of the full rendered DOM.
    // Stored in `__snapshots__/walkthrough.test.tsx.snap`. Framer-motion's
    // mid-animation inline styles (opacity / transform) are scrubbed via
    // `stripFramerMotionInlineStyles` so the snapshot is deterministic
    // across runs while still catching structural regressions.
    // -------------------------------------------------------------------
    expect(stripFramerMotionInlineStyles(container)).toMatchSnapshot();

    // Sanity — the rehydrate localStorage key is cleared on terminal so a
    // refresh would land on a clean home view.
    expect(window.localStorage.getItem(ACTIVE_DELIBERATION_KEY)).toBeNull();
  });
});
