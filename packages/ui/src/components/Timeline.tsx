import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type { DeliberationResult, Turn } from '../lib/types';
import { TurnCard } from './TurnCard';
import { ObservabilityPanel, ObservabilityToggle } from './ObservabilityPanel';

interface Props {
  result: DeliberationResult | null;
  running: boolean;
  elapsedSec: number;
  topic: string | null;
}

interface RoundGroup {
  round: number;
  turns: Turn[];
}

function groupIntoRounds(turns: Turn[]): RoundGroup[] {
  const byRound = new Map<number, Turn[]>();
  for (const t of turns) {
    const list = byRound.get(t.round);
    if (list) {
      list.push(t);
    } else {
      byRound.set(t.round, [t]);
    }
  }
  return Array.from(byRound.entries())
    .sort(([a], [b]) => a - b)
    .map(([round, ts]) => ({ round, turns: ts }));
}

function formatElapsed(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function durationSeconds(startedAt: string, completedAt: string): number | null {
  const s = Date.parse(startedAt);
  const c = Date.parse(completedAt);
  if (Number.isNaN(s) || Number.isNaN(c)) return null;
  const diff = Math.max(0, Math.round((c - s) / 1000));
  return diff;
}

function ResultBanner({ result }: { result: DeliberationResult }) {
  const isConsensus = result.resolved;
  const durationSec = durationSeconds(result.started_at, result.completed_at);

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.98 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.4 }}
      className={`relative overflow-hidden rounded-xl p-4 ${
        isConsensus
          ? 'bg-emerald-500/[0.06] ring-1 ring-emerald-400/20'
          : 'bg-amber-500/[0.06] ring-1 ring-amber-400/20'
      }`}
    >
      {/* Glow effect */}
      <div
        className={`absolute -top-12 left-1/2 h-24 w-48 -translate-x-1/2 rounded-full blur-3xl ${
          isConsensus ? 'bg-emerald-400/10' : 'bg-amber-400/10'
        }`}
      />

      <div className="relative flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-2">
          {isConsensus ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="text-emerald-400">
              <path d="M20 6L9 17l-5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="text-amber-400">
              <path d="M12 9v4m0 4h.01M12 2l9 17H3L12 2z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          )}
          <span className={`text-sm font-semibold ${isConsensus ? 'text-emerald-300' : 'text-amber-300'}`}>
            {isConsensus ? 'Consensus reached' : 'No consensus'}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-3 text-xs text-zinc-400">
          <span className="flex items-center gap-1.5">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" className="text-zinc-500">
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.5"/>
              <path d="M12 6v6l4 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
            {result.totalRounds} rounds
          </span>
          <span className="h-3 w-px bg-white/10" />
          <span>{result.terminationReason.replace(/_/g, ' ')}</span>
          <span className="h-3 w-px bg-white/10" />
          <span>residue {result.residueScore.toFixed(2)}</span>
          {durationSec !== null && (
            <>
              <span className="h-3 w-px bg-white/10" />
              <span>duration {formatElapsed(durationSec)}</span>
            </>
          )}
        </div>
      </div>
    </motion.div>
  );
}

export function Timeline({ result, running, elapsedSec, topic }: Props) {
  const rounds = result ? groupIntoRounds(result.turns) : [];
  // PAR-5 — Observability panel is closed by default. Toggle lives in the
  // Timeline header; the panel itself mounts directly under the header so
  // it's an inspection layer that never dominates the transcript.
  const [observabilityOpen, setObservabilityOpen] = useState(false);

  return (
    <section className="space-y-5">
      {/* Section header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-zinc-500">
            Deliberation
          </h2>
          {running && (
            <span className="flex items-center gap-1.5 rounded-full bg-blue-500/10 px-2.5 py-0.5 text-2xs font-medium text-blue-300 ring-1 ring-blue-400/20">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-75" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-blue-400" />
              </span>
              Live
            </span>
          )}
        </div>
        <ObservabilityToggle
          open={observabilityOpen}
          onToggle={() => setObservabilityOpen((v) => !v)}
        />
      </div>

      {/* Observability panel — hidden by default, opens via the header toggle */}
      <ObservabilityPanel result={result} open={observabilityOpen} />

      {/* Topic hero */}
      {topic && (
        <motion.div
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
          className="rounded-xl bg-white/[0.02] p-4 ring-1 ring-white/[0.06]"
        >
          <p className="mb-1 text-2xs font-semibold uppercase tracking-widest text-zinc-500">
            Topic
          </p>
          <p className="text-lg font-medium text-zinc-100">{topic}</p>
        </motion.div>
      )}

      {/* Running indicator */}
      <AnimatePresence>
        {running && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="relative overflow-hidden rounded-xl bg-blue-500/[0.05] p-4 ring-1 ring-blue-400/15"
          >
            {/* Animated shimmer */}
            <div className="absolute inset-0 animate-shimmer bg-shimmer bg-[length:200%_100%]" />

            <div className="relative flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-500/10">
                  <svg className="h-4 w-4 animate-spin text-blue-400" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3"/>
                    <path className="opacity-75" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" fill="currentColor"/>
                  </svg>
                </div>
                <div>
                  <p className="text-sm font-medium text-blue-200">Agents deliberating</p>
                  <p className="text-2xs text-blue-300/50">
                    Awaiting full result from server
                  </p>
                </div>
              </div>
              <div className="text-right">
                <span className="font-mono text-lg font-semibold tabular-nums text-blue-300/80">
                  {formatElapsed(elapsedSec)}
                </span>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Result banner */}
      {result && <ResultBanner result={result} />}

      {/* Synthesis */}
      <AnimatePresence>
        {result?.synthesis && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            className="relative overflow-hidden rounded-xl bg-blue-500/[0.04] p-5 ring-1 ring-blue-400/15"
          >
            <div className="absolute -top-8 right-8 h-32 w-32 rounded-full bg-blue-500/[0.06] blur-3xl" />
            <div className="relative">
              <div className="mb-3 flex items-center gap-2">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="text-blue-400">
                  <path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                </svg>
                <h3 className="text-xs font-semibold uppercase tracking-widest text-blue-300/80">
                  Synthesis
                </h3>
              </div>
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-zinc-200/90">
                {result.synthesis}
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Split positions */}
      <AnimatePresence>
        {result?.split && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            className="relative overflow-hidden rounded-xl bg-rose-500/[0.04] p-5 ring-1 ring-rose-400/15"
          >
            <div className="relative">
              <div className="mb-3 flex items-center gap-2">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="text-rose-400">
                  <path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                <h3 className="text-xs font-semibold uppercase tracking-widest text-rose-300/80">
                  Split positions
                  {result.split.irreconcilable && (
                    <span className="ml-2 rounded-md bg-rose-500/15 px-1.5 py-0.5 text-2xs font-medium normal-case text-rose-400">
                      irreconcilable
                    </span>
                  )}
                </h3>
              </div>
              <dl className="space-y-3">
                {Object.entries(result.split.positions).map(([who, pos]) => (
                  <div key={who} className="rounded-lg bg-white/[0.02] p-3">
                    <dt className="mb-1 text-2xs font-semibold uppercase tracking-wider text-zinc-500">
                      {who}
                    </dt>
                    <dd className="text-sm text-zinc-300/90">{pos}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Rounds */}
      <div className="space-y-8">
        {rounds.map((group, idx) => (
          <motion.div
            key={group.round}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: idx * 0.1 }}
          >
            {/* Round header */}
            <div className="mb-4 flex items-center gap-3">
              <span className="flex h-6 items-center rounded-md bg-white/[0.04] px-2.5 font-mono text-2xs font-semibold uppercase tracking-widest text-zinc-500 ring-1 ring-white/[0.06]">
                Round {group.round}
              </span>
              <div className="h-px flex-1 bg-gradient-to-r from-white/[0.06] to-transparent" />
            </div>

            {/* Turn cards grid */}
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {group.turns.map((t, i) => (
                <TurnCard key={`${group.round}-${i}`} turn={t} index={i} />
              ))}
            </div>
          </motion.div>
        ))}
      </div>

      {/* Conflicts */}
      <AnimatePresence>
        {result && result.conflicts.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            className="rounded-xl bg-white/[0.02] p-5 ring-1 ring-white/[0.06]"
          >
            <div className="mb-3 flex items-center gap-2">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="text-zinc-500">
                <path d="M12 9v4m0 4h.01M12 2l9 17H3L12 2z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              <h3 className="text-xs font-semibold uppercase tracking-widest text-zinc-400">
                Conflicts
              </h3>
            </div>
            <ul className="space-y-2.5">
              {result.conflicts.map((c, i) => (
                <li key={i} className="flex items-start gap-3 rounded-lg bg-white/[0.02] p-3">
                  <span
                    className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ring-2 ${
                      c.resolved
                        ? 'bg-emerald-400 ring-emerald-400/20'
                        : 'bg-amber-400 ring-amber-400/20'
                    }`}
                  />
                  <div>
                    <span className="font-mono text-2xs font-medium text-zinc-500">
                      {c.between.join(' vs ')}
                    </span>
                    <p className="mt-0.5 text-sm text-zinc-300/90">{c.description}</p>
                  </div>
                </li>
              ))}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Empty state */}
      {!running && !result && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.2 }}
          className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-white/[0.06] bg-white/[0.01] py-16 text-center"
        >
          <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-white/[0.03] ring-1 ring-white/[0.06]">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" className="text-zinc-600">
              <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2v10z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
          <p className="text-sm font-medium text-zinc-500">No deliberation yet</p>
          <p className="mt-1 text-xs text-zinc-600">
            Enter a topic above to begin multi-agent deliberation
          </p>
        </motion.div>
      )}
    </section>
  );
}
