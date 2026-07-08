/**
 * PAR-26 — UI subscription to the PAR-18 SSE stream.
 *
 * Layers a live `EventSource` subscription on top of the legacy 2-second
 * polling loop so Star Chamber-class runs render turns sub-second after
 * server-side persistence instead of in 2-second batches. The hook owns:
 *
 *   - Opening `EventSource('/api/deliberate/:id/stream')` (when `mode`
 *     is `'live'`).
 *   - Accumulating each `event: turn` and `event: system_event` into the
 *     in-progress `DeliberationResult`.
 *   - Detecting the terminal `event: status` (`completed` or `failed`),
 *     fetching `GET /deliberate/:id` exactly once for the canonical
 *     snapshot (synthesizer output, residue, etc.), and surfacing it.
 *   - Falling back to `pollDeliberation` (2s loop) when the SSE path is
 *     unavailable — either because the `EventSource` constructor throws
 *     (older Safari, certain proxies) or the connection emits `error`
 *     before any terminal status arrived.
 *   - Cleaning up on unmount, on terminal status, on user-initiated
 *     abort, and on switching to a different deliberation id.
 *
 * Dedupe strategy
 * ---------------
 * The SSE stream replays already-persisted turns/events on connect, then
 * forwards live broker pushes. To avoid double-rendering, the hook treats
 * the SSE stream as the SINGLE source of truth for the in-progress
 * `turns[]` / `events[]`: when SSE opens we reset both arrays and rebuild
 * them from the wire. The rehydrate path's pre-SSE `GET /deliberate/:id`
 * is used ONLY to decide whether to enter live mode (status: in_flight)
 * or render directly (terminal); its `turns` are discarded once the
 * stream is open.
 *
 * This is option (a) from the PAR-26 ticket — chosen over (b) "GET first,
 * dedupe in SSE" because turns lack a stable id field on the wire (they
 * carry `agent + round + timestamp`, which we don't want to anchor a
 * dedupe key to). Throwing away the GET's accumulated turns and letting
 * the SSE replay re-populate them is two extra round-trips of cheap
 * JSON parsing in exchange for a much simpler invariant.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { getDeliberation } from './api';
import type {
  DeliberationResult,
  DeliberationStatus,
  SystemEvent,
  Turn,
} from './types';

/**
 * Polling interval for the legacy fallback path. Matches the pre-PAR-26
 * 2-second cadence so existing tests / muscle memory keep working.
 */
const POLL_INTERVAL_MS = 2000;

export interface UseDeliberationStreamOptions {
  /**
   * Active deliberation id. When non-null the hook subscribes; setting it
   * to `null` (or unmounting) tears down any open EventSource / poll loop
   * synchronously.
   */
  id: string | null;
  /**
   * Optional initial result to seed from. Used by App.tsx during the
   * rehydrate path: the mount-time GET tells us the run is `in_flight`
   * and gives us the topic/preset to render in the topic hero before the
   * first SSE turn lands. Once the SSE connection opens, the hook resets
   * `turns` / `events` and rebuilds from the wire (see "Dedupe strategy"
   * in the file header).
   */
  initialResult?: DeliberationResult | null;
  /**
   * Called once when the run reaches a terminal status (`completed` or
   * `failed`). The hook also surfaces the final `result` via state, but
   * this callback is the right place for App-level cleanup like clearing
   * the localStorage rehydrate key so a second refresh lands clean.
   */
  onTerminal?: (final: DeliberationResult) => void;
}

export interface UseDeliberationStreamState {
  /** Current snapshot — partial during live, canonical after terminal. */
  result: DeliberationResult | null;
  /**
   * `true` while the hook is actively subscribed (SSE open OR poll loop
   * running). Flips `false` once the run terminates or is aborted.
   */
  running: boolean;
  /**
   * Surfaced when a `status: 'failed'` event lands. Mirrors the engine
   * error string from the canonical `GET /deliberate/:id` snapshot.
   * `null` while the run is in flight or completed cleanly.
   */
  error: string | null;
  /** `'sse'` while the EventSource is the active source, `'poll'` while the legacy loop is running, `'idle'` when nothing is subscribed. */
  mode: 'idle' | 'sse' | 'poll';
}

/**
 * Sentinel pseudo-result used when SSE opens before any GET data is
 * available. Mirrors the empty in-flight shape `GET /deliberate/:id`
 * would have returned at this moment, with the topic blank — App fills
 * in the topic via its own `topic` state which it sets at submit time.
 */
function makeEmptyInFlightResult(seed: Partial<DeliberationResult> = {}): DeliberationResult {
  return {
    topic: '',
    turns: [],
    conflicts: [],
    residueScore: 0,
    resolved: false,
    synthesis: null,
    split: null,
    terminationReason: 'max_rounds',
    totalRounds: 0,
    started_at: '',
    completed_at: '',
    events: [],
    status: 'in_flight',
    ...seed,
  };
}

/**
 * Resolve the global `EventSource` constructor. Wrapped so tests can stub
 * it via `vi.stubGlobal('EventSource', ...)` and so a missing /
 * throwing constructor (older browsers, bizarre proxies) flips us onto
 * the polling fallback instead of crashing the React tree.
 */
function getEventSourceCtor(): typeof EventSource | null {
  try {
    const ctor = (globalThis as { EventSource?: typeof EventSource }).EventSource;
    return typeof ctor === 'function' ? ctor : null;
  } catch {
    return null;
  }
}

/**
 * The hook itself. See file header for the contract.
 */
export function useDeliberationStream({
  id,
  initialResult = null,
  onTerminal,
}: UseDeliberationStreamOptions): UseDeliberationStreamState {
  const [result, setResult] = useState<DeliberationResult | null>(initialResult);
  const [running, setRunning] = useState<boolean>(id !== null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<UseDeliberationStreamState['mode']>('idle');

  // Latest onTerminal in a ref so we don't reopen the stream when the
  // caller passes a fresh inline closure each render.
  const onTerminalRef = useRef(onTerminal);
  onTerminalRef.current = onTerminal;

  // Latest initialResult tracked the same way; only consumed during the
  // initial subscription cycle.
  const initialResultRef = useRef(initialResult);
  initialResultRef.current = initialResult;

  const handleTerminal = useCallback(
    (final: DeliberationResult, finalError: string | null): void => {
      setResult(final);
      setRunning(false);
      setError(finalError);
      setMode('idle');
      onTerminalRef.current?.(final);
    },
    [],
  );

  useEffect(() => {
    if (!id) {
      setRunning(false);
      setMode('idle');
      return;
    }

    let cancelled = false;
    let es: EventSource | null = null;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    // Fence: once SSE has produced at least one event we never fall
    // through to the polling path on a later transient error — the
    // server already told us turns are flowing. The fallback exists
    // for the boot-time case where SSE never connected at all.
    let sseEverEmitted = false;
    let sseTerminal = false;

    setRunning(true);
    setError(null);

    /**
     * Fetch the canonical snapshot once and surface it as terminal.
     * Used both by the SSE terminal-status branch and as the polling
     * loop's fast-path when the GET response itself is terminal.
     */
    const finalize = async (
      finalStatus: DeliberationStatus,
      streamErrorMessage?: string,
    ): Promise<void> => {
      try {
        const snapshot = await getDeliberation(id);
        if (cancelled) return;
        // Carry forward the stream-side error message when the snapshot
        // didn't include one (older server builds, race window) so the
        // failure UI never silently disappears.
        const inferredError =
          finalStatus === 'failed'
            ? snapshot.error ?? streamErrorMessage ?? 'Deliberation failed.'
            : null;
        const merged: DeliberationResult = {
          ...snapshot,
          status: snapshot.status ?? finalStatus,
          ...(inferredError !== null ? { error: inferredError } : {}),
        };
        handleTerminal(merged, inferredError);
      } catch (err) {
        if (cancelled) return;
        // Even if the canonical fetch fails we still want to render
        // SOMETHING terminal so the in-progress card flips off. Use
        // whatever we accumulated locally and bolt the error on.
        const fallbackErr =
          err instanceof Error ? err.message : String(err);
        setResult((prev) => {
          const base = prev ?? makeEmptyInFlightResult();
          return {
            ...base,
            status: finalStatus,
            ...(finalStatus === 'failed'
              ? { error: streamErrorMessage ?? fallbackErr }
              : {}),
          };
        });
        setRunning(false);
        setMode('idle');
        setError(
          finalStatus === 'failed'
            ? streamErrorMessage ?? fallbackErr
            : null,
        );
      }
    };

    /**
     * Legacy 2-second polling loop. Engaged when `EventSource` cannot
     * be constructed (constructor throws, missing global) or when the
     * connection errors out before any data flowed. Reaches the same
     * terminal state as the SSE path — `finalize()` is the shared exit.
     */
    const startPolling = (): void => {
      if (cancelled) return;
      setMode('poll');

      const tick = async (): Promise<void> => {
        if (cancelled) return;
        try {
          const snapshot = await getDeliberation(id);
          if (cancelled) return;
          setResult(snapshot);
          const status: DeliberationStatus = snapshot.status ?? 'completed';
          if (status === 'in_flight') {
            pollTimer = setTimeout(() => {
              void tick();
            }, POLL_INTERVAL_MS);
            return;
          }
          // Terminal status from the polling path — surface it the same
          // way the SSE terminal-status branch would.
          const finalError =
            status === 'failed'
              ? snapshot.error ?? 'Deliberation failed.'
              : null;
          handleTerminal(snapshot, finalError);
        } catch (err) {
          if (cancelled) return;
          // Transient errors (network blip, server restart) shouldn't
          // tear down the rehydrate — keep retrying on the same cadence.
          // A persistent failure manifests as an unending poll, which is
          // visually identical to the pre-PAR-26 behavior.
          const message = err instanceof Error ? err.message : String(err);
          // 404 — id is stale, give up so the App can clear localStorage.
          if (/HTTP 404/i.test(message)) {
            setError(message);
            setRunning(false);
            setMode('idle');
            return;
          }
          pollTimer = setTimeout(() => {
            void tick();
          }, POLL_INTERVAL_MS);
        }
      };

      void tick();
    };

    /**
     * Open the SSE stream. Falls through to `startPolling()` on any
     * boot-time failure (constructor throws, missing global, immediate
     * error event before any data).
     */
    const startStreaming = (): void => {
      const ctor = getEventSourceCtor();
      if (ctor === null) {
        startPolling();
        return;
      }

      try {
        es = new ctor(`${import.meta.env.VITE_PARLIAMENT_API ?? ''}/api/deliberate/${encodeURIComponent(id)}/stream`);
      } catch {
        startPolling();
        return;
      }

      setMode('sse');
      // Reset the in-progress turns/events to whatever the seed gave us
      // (topic/preset) but with empty arrays — SSE will replay everything
      // persisted so far and we don't want to render duplicates.
      setResult(() => {
        const seed = initialResultRef.current;
        if (seed === null) {
          return makeEmptyInFlightResult();
        }
        return {
          ...seed,
          turns: [],
          events: [],
          status: 'in_flight',
        };
      });

      let pendingError: string | null = null;

      const onTurn = (ev: MessageEvent): void => {
        if (cancelled) return;
        sseEverEmitted = true;
        try {
          const turn = JSON.parse(ev.data) as Turn;
          setResult((prev) => {
            const base = prev ?? makeEmptyInFlightResult();
            return {
              ...base,
              turns: [...base.turns, turn],
              status: 'in_flight',
            };
          });
        } catch {
          // Malformed payload — drop silently. A malformed turn won't
          // block the run; the canonical snapshot fetch on terminal
          // will reconstruct the truth.
        }
      };

      const onSystemEvent = (ev: MessageEvent): void => {
        if (cancelled) return;
        sseEverEmitted = true;
        try {
          const event = JSON.parse(ev.data) as SystemEvent;
          setResult((prev) => {
            const base = prev ?? makeEmptyInFlightResult();
            return {
              ...base,
              events: [...(base.events ?? []), event],
            };
          });
        } catch {
          // ignore
        }
      };

      const onStatus = (ev: MessageEvent): void => {
        if (cancelled) return;
        sseEverEmitted = true;
        sseTerminal = true;
        try {
          const payload = JSON.parse(ev.data) as {
            status: DeliberationStatus;
            error?: string;
          };
          if (payload.status === 'in_flight') {
            // Defensive — server only emits terminal status, but log+ignore.
            return;
          }
          // Tear down the EventSource immediately; the canonical fetch
          // is the source of truth from here on.
          if (es) {
            try {
              es.close();
            } catch {
              // ignore
            }
            es = null;
          }
          void finalize(payload.status, payload.error);
        } catch {
          // Malformed terminal payload — fall back to a generic
          // completed transition so the UI doesn't hang on the
          // in-progress card forever.
          if (es) {
            try {
              es.close();
            } catch {
              // ignore
            }
            es = null;
          }
          void finalize('completed');
        }
      };

      const onErrorMessage = (ev: MessageEvent): void => {
        if (cancelled) return;
        // Server-emitted `event: error` (e.g. unknown id) — capture
        // the message so the polling fallback can surface it.
        try {
          const payload = JSON.parse(ev.data) as { error?: string };
          if (typeof payload.error === 'string') {
            pendingError = payload.error;
          }
        } catch {
          // ignore
        }
      };

      const onConnectionError = (): void => {
        if (cancelled) return;
        if (sseTerminal) return;
        // Connection dropped. If we already saw turns we keep what we
        // have and switch to polling — the run is still going server-side
        // and we'd rather get the canonical snapshot once it's done than
        // hang in a half-rendered state. Same exit when we never connected
        // at all (boot-time error).
        if (es) {
          try {
            es.close();
          } catch {
            // ignore
          }
          es = null;
        }
        if (sseEverEmitted) {
          // Mid-run drop — the in-progress card already has turns; let
          // polling drive to terminal from here.
          startPolling();
          return;
        }
        // Boot-time error — fall back wholesale.
        if (pendingError !== null) {
          setError(pendingError);
        }
        startPolling();
      };

      es.addEventListener('turn', onTurn);
      es.addEventListener('system_event', onSystemEvent);
      es.addEventListener('status', onStatus);
      es.addEventListener('error', onErrorMessage as EventListener);
      // EventSource emits a generic `error` event on the EventSource
      // object itself when the underlying connection fails. We listen
      // both ways because Hono's `streamSSE` uses `event: error` for
      // server-side errors AND the browser fires native `error` for
      // transport-level drops; the named-event listener above won't
      // see the native error.
      es.onerror = onConnectionError;
    };

    startStreaming();

    return () => {
      cancelled = true;
      if (es) {
        try {
          es.close();
        } catch {
          // ignore
        }
        es = null;
      }
      if (pollTimer !== null) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
    };
  }, [id, handleTerminal]);

  return { result, running, error, mode };
}
