import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { NewDeliberation } from './components/NewDeliberation';
import { Timeline } from './components/Timeline';
import { TranscriptList } from './components/TranscriptList';
import { HealthBar } from './components/HealthBar';
import { getDeliberation, getTranscript, startDeliberation } from './lib/api';
import {
  clearActiveDeliberationId,
  getActiveDeliberationId,
  setActiveDeliberationId,
} from './lib/activeDeliberation';
import type { DeliberationResult } from './lib/types';

export default function App() {
  const [running, setRunning] = useState(false);
  const [topic, setTopic] = useState<string | null>(null);
  const [result, setResult] = useState<DeliberationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!running) {
      if (timerRef.current != null) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
      return;
    }
    setElapsed(0);
    const start = Date.now();
    timerRef.current = window.setInterval(() => {
      setElapsed(Math.floor((Date.now() - start) / 1000));
    }, 1000);
    return () => {
      if (timerRef.current != null) window.clearInterval(timerRef.current);
    };
  }, [running]);

  // PAR-1: rehydrate from a persisted in-flight deliberation id on mount.
  //
  // If a previous tab wrote `parliament:active_deliberation_id` to
  // localStorage and the user hard-refreshed, we re-fetch via
  // `GET /deliberate/:id` so the in-progress / final card re-appears
  // instead of a blank home view. We only run this once on mount and bail
  // cleanly on every error path (404, network, parse) by dropping the key
  // so the next refresh shows a clean state.
  useEffect(() => {
    const persistedId = getActiveDeliberationId();
    if (!persistedId) return;

    let cancelled = false;
    setRunning(true);

    (async () => {
      try {
        const r = await getDeliberation(persistedId);
        if (cancelled) return;
        setResult(r);
        setTopic(r.topic);
        // Server-stored deliberations are always terminal — `saveDeliberation`
        // is only called once the engine returns. Clear the key so a second
        // refresh after the result is on screen lands on the clean home view.
        clearActiveDeliberationId();
      } catch (err) {
        if (cancelled) return;
        // 404 → stale id (engine likely failed before save, or DB was wiped).
        // Drop the key silently so we don't loop on every refresh and so the
        // user lands on a clean home view rather than a scary error banner
        // for an action they didn't take. Non-404 errors (network, parse)
        // surface to the banner so the user knows the rehydrate didn't work.
        clearActiveDeliberationId();
        const message = err instanceof Error ? err.message : String(err);
        if (!/HTTP 404/i.test(message)) {
          setError(message);
        }
      } finally {
        if (!cancelled) setRunning(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSubmit(t: string, preset: string, context?: string) {
    setError(null);
    setResult(null);
    setTopic(t);
    setRunning(true);
    try {
      // PAR-16: forward optional prose context. `startDeliberation` strips
      // empty / whitespace-only values so we don't have to here.
      const r = await startDeliberation(t, { preset, context });
      // PAR-1: persist the returned id so a hard refresh while the result
      // is on screen rehydrates from `GET /deliberate/:id` instead of
      // dropping the user back to an empty home view. The mount effect
      // takes ownership of clearing the key once it has rendered the
      // rehydrated result; explicit user navigation (sidebar click, new
      // submit) also clears via the matching handlers below.
      setActiveDeliberationId(r.id);
      setResult(r);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      // The POST never returned a usable id; nothing to persist. Make sure
      // we don't leave a stale id from a previous run lying around.
      clearActiveDeliberationId();
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  async function handleLoadDeliberation(id: string) {
    setError(null);
    setRunning(false);
    // User explicitly navigated away from any in-flight resume — drop the
    // key so the next refresh starts clean.
    clearActiveDeliberationId();
    try {
      const r = await getDeliberation(id);
      setResult(r);
      setTopic(r.topic);
      setSidebarOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleLoadTranscript(file: string) {
    setError(null);
    setRunning(false);
    clearActiveDeliberationId();
    try {
      const r = await getTranscript(file);
      setResult(r);
      setTopic(r.topic);
      setSidebarOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="relative min-h-screen bg-ink-950">
      {/* Ambient background effects */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-[40%] left-1/2 h-[800px] w-[800px] -translate-x-1/2 rounded-full bg-gradient-radial from-parliament-400/[0.04] via-transparent to-transparent" />
        <div className="absolute -bottom-[20%] -right-[10%] h-[600px] w-[600px] rounded-full bg-gradient-radial from-blue-500/[0.03] via-transparent to-transparent" />
      </div>

      {/* Header */}
      <header className="glass glass-border sticky top-0 z-30">
        <div className="mx-auto max-w-[1400px] px-4 sm:px-6 lg:px-8">
          <div className="flex h-16 items-center justify-between">
            <div className="flex items-center gap-4">
              {/* Logo mark */}
              <div className="relative flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-parliament-400/20 to-parliament-600/20 ring-1 ring-parliament-400/20">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" className="text-parliament-400">
                  <path d="M12 2L2 7l10 5 10-5-10-5z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M2 17l10 5 10-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M2 12l10 5 10-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </div>
              <div>
                <h1 className="text-[15px] font-semibold tracking-tight text-zinc-100">
                  Parliament
                </h1>
                <p className="text-2xs font-medium text-zinc-500">
                  Multi-agent deliberation
                </p>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <HealthBar />
              {/* Mobile sidebar toggle */}
              <button
                type="button"
                onClick={() => setSidebarOpen(!sidebarOpen)}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-200 lg:hidden"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M3 12h18M3 6h18M3 18h18" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* Main layout */}
      <main className="relative mx-auto max-w-[1400px] px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
        <div className="lg:grid lg:grid-cols-[1fr_320px] lg:gap-8">
          {/* Primary column */}
          <div className="min-w-0 space-y-6">
            <NewDeliberation onSubmit={handleSubmit} disabled={running} />

            <AnimatePresence mode="wait">
              {error && (
                <motion.div
                  initial={{ opacity: 0, y: -8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  className="flex items-start gap-3 rounded-xl border border-rose-500/20 bg-rose-500/5 px-4 py-3"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="mt-0.5 shrink-0 text-rose-400">
                    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.5"/>
                    <path d="M12 8v4m0 4h.01" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                  </svg>
                  <p className="text-sm text-rose-200/90">{error}</p>
                </motion.div>
              )}
            </AnimatePresence>

            <Timeline result={result} running={running} elapsedSec={elapsed} topic={topic} />
          </div>

          {/* Sidebar — desktop */}
          <aside className="hidden lg:block">
            <div className="sticky top-24">
              <TranscriptList
                refreshKey={refreshKey}
                onLoadDeliberation={handleLoadDeliberation}
                onLoadTranscript={handleLoadTranscript}
              />
            </div>
          </aside>

          {/* Sidebar — mobile drawer */}
          <AnimatePresence>
            {sidebarOpen && (
              <>
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  onClick={() => setSidebarOpen(false)}
                  className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm lg:hidden"
                />
                <motion.aside
                  initial={{ x: '100%' }}
                  animate={{ x: 0 }}
                  exit={{ x: '100%' }}
                  transition={{ type: 'spring', damping: 25, stiffness: 300 }}
                  className="fixed inset-y-0 right-0 z-50 w-[340px] max-w-[90vw] overflow-y-auto border-l border-white/5 bg-ink-900 p-6 lg:hidden"
                >
                  <div className="mb-4 flex items-center justify-between">
                    <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                      History
                    </span>
                    <button
                      type="button"
                      onClick={() => setSidebarOpen(false)}
                      className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-400 hover:bg-white/5 hover:text-zinc-200"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                        <path d="M18 6L6 18M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                  <TranscriptList
                    refreshKey={refreshKey}
                    onLoadDeliberation={handleLoadDeliberation}
                    onLoadTranscript={handleLoadTranscript}
                  />
                </motion.aside>
              </>
            )}
          </AnimatePresence>
        </div>
      </main>
    </div>
  );
}
