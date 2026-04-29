import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type { DeliberationSummary, TranscriptFile } from '../lib/types';
import { listDeliberations, listTranscripts } from '../lib/api';

interface Props {
  refreshKey: number;
  onLoadDeliberation: (id: string) => void;
  onLoadTranscript: (file: string) => void;
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function TranscriptList({ refreshKey, onLoadDeliberation, onLoadTranscript }: Props) {
  const [deliberations, setDeliberations] = useState<DeliberationSummary[]>([]);
  const [transcripts, setTranscripts] = useState<TranscriptFile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'deliberations' | 'transcripts'>('deliberations');

  useEffect(() => {
    let cancelled = false;
    setError(null);
    Promise.all([listDeliberations(), listTranscripts()])
      .then(([d, t]) => {
        if (cancelled) return;
        setDeliberations(d);
        setTranscripts(t);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const totalCount = deliberations.length + transcripts.length;

  return (
    <aside className="min-w-0 overflow-hidden">
      {/* Header with count */}
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-zinc-500">
          History
        </h2>
        {totalCount > 0 && (
          <span className="flex h-5 min-w-[20px] items-center justify-center rounded-full bg-white/[0.05] px-1.5 text-2xs font-medium tabular-nums text-zinc-500 ring-1 ring-white/[0.06]">
            {totalCount}
          </span>
        )}
      </div>

      {/* Tabs */}
      <div className="mb-4 flex gap-1 rounded-lg bg-white/[0.03] p-1 ring-1 ring-white/[0.06]">
        <button
          type="button"
          onClick={() => setActiveTab('deliberations')}
          className={`flex-1 rounded-md px-3 py-1.5 text-2xs font-semibold transition-all ${
            activeTab === 'deliberations'
              ? 'bg-white/[0.08] text-zinc-200 shadow-sm'
              : 'text-zinc-500 hover:text-zinc-300'
          }`}
        >
          Stored ({deliberations.length})
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('transcripts')}
          className={`flex-1 rounded-md px-3 py-1.5 text-2xs font-semibold transition-all ${
            activeTab === 'transcripts'
              ? 'bg-white/[0.08] text-zinc-200 shadow-sm'
              : 'text-zinc-500 hover:text-zinc-300'
          }`}
        >
          Transcripts ({transcripts.length})
        </button>
      </div>

      {error && (
        <div className="mb-3 flex items-center gap-2 rounded-lg bg-rose-500/5 px-3 py-2 ring-1 ring-rose-400/15">
          <span className="h-1.5 w-1.5 rounded-full bg-rose-400" />
          <p className="text-2xs text-rose-300/80">{error}</p>
        </div>
      )}

      {/* Deliberations list */}
      <AnimatePresence mode="wait">
        {activeTab === 'deliberations' && (
          <motion.div
            key="deliberations"
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 8 }}
            transition={{ duration: 0.2 }}
          >
            {deliberations.length === 0 && !error ? (
              <div className="flex flex-col items-center rounded-xl border border-dashed border-white/[0.06] bg-white/[0.01] py-8 text-center">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" className="mb-2 text-zinc-600">
                  <path d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                <p className="text-2xs text-zinc-500">No deliberations yet</p>
              </div>
            ) : (
              <ul className="space-y-2">
                {deliberations.map((d, i) => (
                  <motion.li
                    key={d.id}
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: i * 0.03 }}
                  >
                    <button
                      type="button"
                      onClick={() => onLoadDeliberation(d.id)}
                      className="surface-interactive block w-full rounded-xl px-3.5 py-3 text-left"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <span className="text-sm font-medium leading-snug text-zinc-200 line-clamp-2">
                          {d.topic}
                        </span>
                        <span
                          className={`mt-0.5 shrink-0 rounded-md px-1.5 py-0.5 text-2xs font-semibold ${
                            d.resolved
                              ? 'bg-emerald-500/10 text-emerald-400 ring-1 ring-emerald-400/20'
                              : 'bg-amber-500/10 text-amber-400 ring-1 ring-amber-400/20'
                          }`}
                        >
                          {d.resolved ? 'consensus' : 'split'}
                        </span>
                      </div>
                      <div className="mt-2 flex items-center gap-2 text-2xs text-zinc-500">
                        <span>{timeAgo(d.created_at)}</span>
                        <span className="h-2.5 w-px bg-white/[0.06]" />
                        <span>{d.total_rounds} rounds</span>
                      </div>
                    </button>
                  </motion.li>
                ))}
              </ul>
            )}
          </motion.div>
        )}

        {activeTab === 'transcripts' && (
          <motion.div
            key="transcripts"
            initial={{ opacity: 0, x: 8 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -8 }}
            transition={{ duration: 0.2 }}
          >
            {transcripts.length === 0 ? (
              <div className="flex flex-col items-center rounded-xl border border-dashed border-white/[0.06] bg-white/[0.01] py-8 text-center">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" className="mb-2 text-zinc-600">
                  <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                <p className="text-2xs text-zinc-500">No transcript files</p>
              </div>
            ) : (
              <ul className="space-y-2">
                {transcripts.map((t, i) => (
                  <motion.li
                    key={t.file}
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: i * 0.03 }}
                  >
                    <button
                      type="button"
                      onClick={() => onLoadTranscript(t.file)}
                      className="surface-interactive block w-full rounded-xl px-3.5 py-3 text-left"
                    >
                      <span className="block text-sm font-medium leading-snug text-zinc-200 line-clamp-2">
                        {t.topic}
                      </span>
                      <div className="mt-2 flex items-center gap-2 text-2xs text-zinc-500">
                        <span className="truncate font-mono">{t.file}</span>
                        {t.created_at && (
                          <>
                            <span className="h-2.5 w-px bg-white/[0.06]" />
                            <span className="shrink-0">{timeAgo(t.created_at)}</span>
                          </>
                        )}
                      </div>
                    </button>
                  </motion.li>
                ))}
              </ul>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </aside>
  );
}
