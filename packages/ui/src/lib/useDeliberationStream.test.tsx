/**
 * PAR-26 — `useDeliberationStream` contract tests.
 *
 * These tests pin the live-rendering invariants the ticket calls out:
 *
 *   1. Mock `EventSource`, push a sequence of `turn` + a terminal `status`
 *      event, assert the in-progress card updates and the canonical
 *      `GET /deliberate/:id` snapshot fetch fires exactly once.
 *   2. Simulate the `EventSource` constructor throwing — assert the
 *      polling fallback engages and still drives to terminal.
 *
 * The fake `EventSource` is intentionally tiny: a constructor that
 * records the URL, an `addEventListener` that registers handlers we can
 * fire from the test, and a `close()` that flips a flag we can assert
 * against. Anything we don't need (readyState, etc.) stays unimplemented.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { useDeliberationStream } from './useDeliberationStream';
import type { DeliberationResult, Turn } from './types';

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

interface FakeEventSourceHandle {
  url: string;
  closed: boolean;
  emit: (event: string, payload: unknown) => void;
  emitNativeError: () => void;
}

const fakeHandles: FakeEventSourceHandle[] = [];

class FakeEventSource {
  private listeners = new Map<string, ((ev: MessageEvent) => void)[]>();
  public onerror: (() => void) | null = null;
  public closed = false;

  constructor(public url: string) {
    const handle: FakeEventSourceHandle = {
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
      emitNativeError: () => {
        self.onerror?.();
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    fakeHandles.push(handle);
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

function lastHandle(): FakeEventSourceHandle {
  const h = fakeHandles[fakeHandles.length - 1];
  if (!h) throw new Error('No EventSource constructed');
  return h;
}

function makeTurn(round: number, agent = 'proposer'): Turn {
  return {
    agent,
    neurotype: agent,
    model: 'mock-model',
    content: `${agent} round ${round}`,
    timestamp: new Date().toISOString(),
    round,
  };
}

function makeCanonical(opts: Partial<DeliberationResult> = {}): DeliberationResult {
  return {
    topic: 'Test topic',
    turns: [makeTurn(1), makeTurn(1, 'skeptic'), makeTurn(2)],
    conflicts: [],
    residueScore: 0.05,
    resolved: true,
    synthesis: 'Final synthesis.',
    split: null,
    terminationReason: 'consensus',
    totalRounds: 2,
    started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    events: [],
    status: 'completed',
    ...opts,
  };
}

function stubFetch(impl: (url: string) => unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    const body = impl(url);
    if (body instanceof Response) return body;
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => body,
      text: async () => '',
    } as unknown as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

// ---------------------------------------------------------------------------
// Probe component — surfaces the hook's state into the DOM so we can
// assert against it via @testing-library/react. We render JSON because
// it's the cheapest way to inspect the full state shape.
// ---------------------------------------------------------------------------

function Probe({ id }: { id: string | null }) {
  const state = useDeliberationStream({ id });
  return (
    <div>
      <span data-testid="mode">{state.mode}</span>
      <span data-testid="running">{String(state.running)}</span>
      <span data-testid="error">{state.error ?? ''}</span>
      <span data-testid="turn-count">
        {state.result ? state.result.turns.length : 0}
      </span>
      <span data-testid="status">{state.result?.status ?? ''}</span>
      <span data-testid="topic">{state.result?.topic ?? ''}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useDeliberationStream — SSE happy path', () => {
  beforeEach(() => {
    fakeHandles.length = 0;
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders streamed turns and fetches the canonical snapshot exactly once on terminal', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const fetchMock = stubFetch((url) => {
      if (/\/deliberate\/.+$/.test(url)) {
        return makeCanonical();
      }
      return {};
    });

    const { getByTestId } = render(<Probe id="abc-123" />);

    // Waiting for the EventSource to be constructed (effect runs after
    // render). Once it is, the hook should be in `sse` mode with no turns.
    await waitFor(() => expect(fakeHandles.length).toBe(1));
    const handle = lastHandle();
    expect(handle.url).toBe('/api/deliberate/abc-123/stream');
    expect(getByTestId('mode').textContent).toBe('sse');
    expect(getByTestId('turn-count').textContent).toBe('0');
    expect(getByTestId('running').textContent).toBe('true');

    // Push two turns over the wire. After each, the in-progress turn count
    // increments — i.e. the in-progress card sees turns as they arrive.
    act(() => {
      handle.emit('turn', makeTurn(1));
    });
    expect(getByTestId('turn-count').textContent).toBe('1');

    act(() => {
      handle.emit('turn', makeTurn(1, 'skeptic'));
    });
    expect(getByTestId('turn-count').textContent).toBe('2');

    // Terminal status. The hook should fetch the canonical snapshot
    // exactly once and surface it.
    act(() => {
      handle.emit('status', { status: 'completed' });
    });

    await waitFor(() => {
      expect(getByTestId('status').textContent).toBe('completed');
    });

    // Canonical fetch fired exactly once and the EventSource is closed.
    const deliberateGets = fetchMock.mock.calls
      .map(([u]) => String(u))
      .filter((u) => /\/deliberate\/[^/]+$/.test(u));
    expect(deliberateGets).toHaveLength(1);
    expect(handle.closed).toBe(true);
    expect(getByTestId('running').textContent).toBe('false');
    expect(getByTestId('mode').textContent).toBe('idle');
    // The canonical snapshot has 3 turns from `makeCanonical()` so the
    // turn-count flips from the 2 streamed turns to the canonical 3.
    expect(getByTestId('turn-count').textContent).toBe('3');
  });

  it('surfaces failure with the canonical error message on terminal: failed', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    stubFetch((url) => {
      if (/\/deliberate\/.+$/.test(url)) {
        return makeCanonical({
          status: 'failed',
          error: 'engine boom',
          synthesis: null,
          resolved: false,
        });
      }
      return {};
    });

    const { getByTestId } = render(<Probe id="failed-123" />);

    await waitFor(() => expect(fakeHandles.length).toBe(1));
    const handle = lastHandle();

    act(() => {
      handle.emit('status', { status: 'failed', error: 'engine boom' });
    });

    await waitFor(() => {
      expect(getByTestId('status').textContent).toBe('failed');
    });
    expect(getByTestId('error').textContent).toBe('engine boom');
    expect(handle.closed).toBe(true);
  });
});

describe('useDeliberationStream — polling fallback', () => {
  beforeEach(() => {
    fakeHandles.length = 0;
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('falls back to polling when EventSource constructor throws', async () => {
    // Constructor throws synchronously — simulates a browser/proxy that
    // refuses to open an SSE connection (older Safari, some corporate
    // proxies, etc.).
    class BrokenEventSource {
      constructor() {
        throw new Error('SSE blocked');
      }
    }
    vi.stubGlobal('EventSource', BrokenEventSource);

    // First poll returns terminal directly so we don't have to wait
    // 2s for a second poll. The fallback engaging at all is what the
    // ticket specifies — polling cadence is the legacy contract.
    let pollCount = 0;
    const fetchMock = stubFetch((url) => {
      if (/\/deliberate\/.+$/.test(url)) {
        pollCount += 1;
        return makeCanonical();
      }
      return {};
    });

    const { getByTestId } = render(<Probe id="poll-123" />);

    // Hook should never construct an EventSource since the wrapper
    // returns null when the constructor throws.
    expect(fakeHandles.length).toBe(0);

    // The polling fallback engaged AND drove to terminal on the first
    // poll. (The mode briefly flips to `poll` then to `idle` on
    // terminal — we assert the terminal end-state which is what the
    // ticket cares about: "still completes rehydrate".)
    await waitFor(() => {
      expect(getByTestId('status').textContent).toBe('completed');
    });
    expect(getByTestId('running').textContent).toBe('false');
    expect(pollCount).toBe(1);
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('falls back to polling when EventSource fires a connection error before any data', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    let pollCount = 0;
    stubFetch((url) => {
      if (/\/deliberate\/.+$/.test(url)) {
        pollCount += 1;
        return makeCanonical();
      }
      return {};
    });

    const { getByTestId } = render(<Probe id="conn-err" />);

    await waitFor(() => expect(fakeHandles.length).toBe(1));
    const handle = lastHandle();

    // Boot-time native error (no `event: turn` ever fired) — the hook
    // should close the SSE and start polling.
    act(() => {
      handle.emitNativeError();
    });

    await waitFor(() => {
      expect(getByTestId('status').textContent).toBe('completed');
    });
    expect(handle.closed).toBe(true);
    expect(pollCount).toBeGreaterThanOrEqual(1);
  });
});

describe('useDeliberationStream — cleanup', () => {
  beforeEach(() => {
    fakeHandles.length = 0;
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('closes the EventSource on unmount before terminal status', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    stubFetch(() => ({}));

    const { unmount } = render(<Probe id="unmount-id" />);
    await waitFor(() => expect(fakeHandles.length).toBe(1));
    const handle = lastHandle();

    unmount();
    expect(handle.closed).toBe(true);
  });

  it('closes the previous EventSource and opens a new one when the id changes', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    stubFetch(() => ({}));

    const { rerender } = render(<Probe id="first-id" />);
    await waitFor(() => expect(fakeHandles.length).toBe(1));
    const first = lastHandle();
    expect(first.url).toBe('/api/deliberate/first-id/stream');

    rerender(<Probe id="second-id" />);
    await waitFor(() => expect(fakeHandles.length).toBe(2));
    const second = lastHandle();
    expect(first.closed).toBe(true);
    expect(second.url).toBe('/api/deliberate/second-id/stream');
  });

  it('does not subscribe when id is null', () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    stubFetch(() => ({}));

    const { getByTestId } = render(<Probe id={null} />);
    expect(fakeHandles.length).toBe(0);
    expect(getByTestId('mode').textContent).toBe('idle');
    expect(getByTestId('running').textContent).toBe('false');
  });
});
