/**
 * PAR-1 — refresh-survival contract for in-flight deliberations.
 *
 * These tests pin the localStorage handshake described in the ticket:
 *
 *   1. Submit success persists the returned id so a hard refresh has
 *      something to rehydrate against.
 *   2. App mount with a persisted id rehydrates via `GET /deliberate/:id`
 *      and renders the result.
 *   3. The persisted id is cleared once rehydrate completes (so a second
 *      refresh lands on a clean home view) and on terminal error paths
 *      (404 stale id, submit failure).
 *   4. App mount with no persisted id is a no-op — the home state stays
 *      clean and no fetch fires for a missing key.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import App from './App';
import { ACTIVE_DELIBERATION_KEY } from './lib/activeDeliberation';

const PRESETS_RESPONSE = {
  presets: [
    {
      id: 'debate',
      name: 'Debate',
      description: 'Default debate preset.',
      best_for: 'Open arguments.',
    },
  ],
  defaultPreset: 'debate',
};

const HEALTH_RESPONSE = {
  status: 'ok',
  models: { 'mock-model': 'connected' as const },
};

interface RehydrateResultOptions {
  topic?: string;
  resolved?: boolean;
}

function makeRehydrateResult(opts: RehydrateResultOptions = {}) {
  return {
    topic: opts.topic ?? 'Is AI a threat to humanity?',
    turns: [
      {
        agent: 'proposer',
        neurotype: 'proposer',
        model: 'mock-model',
        content: 'Opening statement.',
        timestamp: new Date().toISOString(),
        round: 1,
      },
    ],
    conflicts: [],
    residueScore: 0.1,
    resolved: opts.resolved ?? true,
    synthesis: 'Final synthesis.',
    split: null,
    terminationReason: 'consensus',
    totalRounds: 1,
    started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
  };
}

interface FetchPlan {
  /** Result returned by GET /deliberate/:id. */
  rehydrateResult?: ReturnType<typeof makeRehydrateResult>;
  /** Force GET /deliberate/:id to 404. */
  rehydrate404?: boolean;
}

function stubFetch(plan: FetchPlan = {}): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo) => {
    const url = typeof input === 'string' ? input : (input as Request).url;

    if (url.includes('/presets')) {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => PRESETS_RESPONSE,
        text: async () => '',
      } as unknown as Response;
    }

    if (url.includes('/health')) {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => HEALTH_RESPONSE,
        text: async () => '',
      } as unknown as Response;
    }

    if (url.includes('/deliberations')) {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ deliberations: [] }),
        text: async () => '',
      } as unknown as Response;
    }

    if (url.includes('/transcripts')) {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ transcripts: [] }),
        text: async () => '',
      } as unknown as Response;
    }

    // GET /deliberate/:id — the rehydrate path.
    if (/\/deliberate\//.test(url)) {
      if (plan.rehydrate404) {
        return {
          ok: false,
          status: 404,
          statusText: 'Not Found',
          json: async () => ({ error: 'not found' }),
          text: async () => 'not found',
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => plan.rehydrateResult ?? makeRehydrateResult(),
        text: async () => '',
      } as unknown as Response;
    }

    // Default — empty success.
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({}),
      text: async () => '',
    } as unknown as Response;
  });

  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

// ---------------------------------------------------------------------------
// PAR-26 — fake EventSource + SSE-aware fetch stub for live-stream tests.
//
// The PAR-1 tests above use a stub that never sets `status`, so the App's
// rehydrate path falls through to the legacy "render directly" branch.
// The PAR-26 tests below override that with `status: 'in_flight'` so the
// streaming hook engages, and provide a fake `EventSource` we can drive
// from the test.
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

describe('App refresh persistence (PAR-1)', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it('rehydrates the in-flight deliberation from localStorage on mount', async () => {
    window.localStorage.setItem(ACTIVE_DELIBERATION_KEY, 'persisted-id-123');
    const fetchMock = stubFetch({
      rehydrateResult: makeRehydrateResult({ topic: 'Refresh-survival topic' }),
    });

    render(<App />);

    // Topic from the rehydrated result lands in the DOM — i.e. the
    // in-progress card re-appeared instead of a blank home view.
    await waitFor(() => {
      expect(screen.getByText('Refresh-survival topic')).toBeInTheDocument();
    });

    // The fetch hit the persisted id verbatim.
    const calls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(calls.some((u) => u.includes('/deliberate/persisted-id-123'))).toBe(true);

    // After a successful rehydrate the key is cleared so a second refresh
    // lands on a clean home view (and not on a stale loop).
    expect(window.localStorage.getItem(ACTIVE_DELIBERATION_KEY)).toBeNull();
  });

  it('clears a stale id silently when GET /deliberate/:id 404s', async () => {
    window.localStorage.setItem(ACTIVE_DELIBERATION_KEY, 'gone-id');
    stubFetch({ rehydrate404: true });

    render(<App />);

    // The empty-state copy is the marker that we landed on a clean home
    // view rather than rendering a scary error banner for a 404.
    await waitFor(() => {
      expect(screen.getByText(/no deliberation yet/i)).toBeInTheDocument();
    });

    expect(window.localStorage.getItem(ACTIVE_DELIBERATION_KEY)).toBeNull();
  });

  it('does not fetch /deliberate/:id when no id is persisted', async () => {
    const fetchMock = stubFetch();

    render(<App />);

    // Clean home view: empty-state copy is visible, no rehydrate fetch.
    await waitFor(() => {
      expect(screen.getByText(/no deliberation yet/i)).toBeInTheDocument();
    });

    const deliberateGet = fetchMock.mock.calls
      .map(([url]) => String(url))
      .filter((u) => /\/deliberate\/[^/?]+$/.test(u));
    expect(deliberateGet).toHaveLength(0);
    expect(window.localStorage.getItem(ACTIVE_DELIBERATION_KEY)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// PAR-26 — SSE rehydrate integration.
//
// When `GET /deliberate/:id` returns `status: 'in_flight'`, the App should
// hand off to `useDeliberationStream` which opens an EventSource. Driving
// a turn + terminal status through that fake EventSource exercises the
// full submit/rehydrate -> stream -> canonical-fetch path end-to-end.
// ---------------------------------------------------------------------------

describe('App SSE rehydrate (PAR-26)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    fakeHandles.length = 0;
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it('opens SSE on rehydrate when status is in_flight, renders streamed turns, fetches final snapshot once on terminal', async () => {
    window.localStorage.setItem(ACTIVE_DELIBERATION_KEY, 'inflight-77');

    // First GET (rehydrate) returns in_flight; second GET (terminal
    // snapshot) returns the canonical completed result.
    let getCount = 0;
    const fetchMock = vi.fn(async (input: RequestInfo) => {
      const url = typeof input === 'string' ? input : (input as Request).url;

      if (url.includes('/presets')) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => PRESETS_RESPONSE,
          text: async () => '',
        } as unknown as Response;
      }
      if (url.includes('/health')) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => HEALTH_RESPONSE,
          text: async () => '',
        } as unknown as Response;
      }
      if (url.includes('/deliberations')) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({ deliberations: [] }),
          text: async () => '',
        } as unknown as Response;
      }
      if (url.includes('/transcripts')) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({ transcripts: [] }),
          text: async () => '',
        } as unknown as Response;
      }
      if (/\/deliberate\/[^/]+$/.test(url)) {
        getCount += 1;
        if (getCount === 1) {
          return {
            ok: true,
            status: 200,
            statusText: 'OK',
            json: async () => ({
              ...makeRehydrateResult({ topic: 'Live SSE topic' }),
              status: 'in_flight',
              turns: [],
              synthesis: null,
              resolved: false,
            }),
            text: async () => '',
          } as unknown as Response;
        }
        // Canonical terminal snapshot.
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({
            ...makeRehydrateResult({ topic: 'Live SSE topic' }),
            status: 'completed',
          }),
          text: async () => '',
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({}),
        text: async () => '',
      } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('EventSource', FakeEventSource);

    render(<App />);

    // Wait for the rehydrate GET to resolve and the EventSource to open.
    await waitFor(() => expect(fakeHandles.length).toBe(1));
    const handle = fakeHandles[0]!;
    expect(handle.url).toBe('/api/deliberate/inflight-77/stream');

    // Topic from the in_flight GET should already be in the DOM.
    await waitFor(() => {
      expect(screen.getByText('Live SSE topic')).toBeInTheDocument();
    });

    // Push a turn over the wire — the in-progress card sees it land.
    await act(async () => {
      handle.emit('turn', {
        agent: 'proposer',
        neurotype: 'proposer',
        model: 'mock-model',
        content: 'Streamed turn content.',
        timestamp: new Date().toISOString(),
        round: 1,
      });
    });
    await waitFor(() => {
      expect(screen.getByText('Streamed turn content.')).toBeInTheDocument();
    });

    // Terminal status — the App should fetch the canonical snapshot
    // exactly once and clear the localStorage rehydrate key.
    await act(async () => {
      handle.emit('status', { status: 'completed' });
    });

    await waitFor(() => {
      // Final synthesis from the canonical GET lands.
      expect(screen.getByText('Final synthesis.')).toBeInTheDocument();
    });

    // Exactly two GETs against `/deliberate/:id`: one for the rehydrate,
    // one for the canonical terminal snapshot.
    expect(getCount).toBe(2);
    expect(handle.closed).toBe(true);
    expect(window.localStorage.getItem(ACTIVE_DELIBERATION_KEY)).toBeNull();
  });

  it('renders a failure card when terminal status is failed', async () => {
    window.localStorage.setItem(ACTIVE_DELIBERATION_KEY, 'doomed-id');

    let getCount = 0;
    const fetchMock = vi.fn(async (input: RequestInfo) => {
      const url = typeof input === 'string' ? input : (input as Request).url;

      if (url.includes('/presets')) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => PRESETS_RESPONSE,
          text: async () => '',
        } as unknown as Response;
      }
      if (url.includes('/health')) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => HEALTH_RESPONSE,
          text: async () => '',
        } as unknown as Response;
      }
      if (url.includes('/deliberations')) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({ deliberations: [] }),
          text: async () => '',
        } as unknown as Response;
      }
      if (url.includes('/transcripts')) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({ transcripts: [] }),
          text: async () => '',
        } as unknown as Response;
      }
      if (/\/deliberate\/[^/]+$/.test(url)) {
        getCount += 1;
        if (getCount === 1) {
          return {
            ok: true,
            status: 200,
            statusText: 'OK',
            json: async () => ({
              ...makeRehydrateResult({ topic: 'Doomed run' }),
              status: 'in_flight',
              turns: [],
              synthesis: null,
              resolved: false,
            }),
            text: async () => '',
          } as unknown as Response;
        }
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({
            ...makeRehydrateResult({ topic: 'Doomed run' }),
            status: 'failed',
            error: 'engine exploded',
            synthesis: null,
            resolved: false,
          }),
          text: async () => '',
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({}),
        text: async () => '',
      } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('EventSource', FakeEventSource);

    render(<App />);

    await waitFor(() => expect(fakeHandles.length).toBe(1));
    const handle = fakeHandles[0]!;

    await act(async () => {
      handle.emit('status', {
        status: 'failed',
        error: 'engine exploded',
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('deliberation-failed-card')).toBeInTheDocument();
    });
    // The error message lands in the card (and the global banner).
    expect(
      screen.getByTestId('deliberation-failed-card').textContent,
    ).toContain('engine exploded');
  });
});
