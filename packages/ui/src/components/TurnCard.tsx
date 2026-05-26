import { motion } from 'framer-motion';
import type { Turn } from '../lib/types';
import { roleStyle } from '../lib/roles';

interface Props {
  turn: Turn;
  index: number;
}

/**
 * Format the engine's signed `convergence_delta` for the secondary line.
 *
 * - `null` / `undefined` → `—` (round 1, or no prior synthesis to compare).
 * - Negative → Unicode minus (`−`) prefix.
 * - Zero or positive → `+` prefix (zero is rendered as `+0.00`, treated as
 *   "no movement" per PRD: still numeric, not the em-dash).
 */
function formatConvergenceDelta(delta: number | null | undefined): string {
  if (delta == null) return '—';
  const abs = Math.abs(delta).toFixed(2);
  if (delta < 0) return `\u2212${abs}`;
  return `+${abs}`;
}

/**
 * Format a millisecond latency for the PAR-24 footer chip. Sub-second values
 * stay in `ms` so 800ms doesn't collapse to a misleading `0.8s`; everything
 * above one second renders as `N.Ns` so a typical 12-second turn shows as
 * `12.0s` rather than `12000ms`.
 */
function formatLatencyMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function TurnCard({ turn, index }: Props) {
  const style = roleStyle(turn.agent);
  const time = new Date(turn.timestamp).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
  });

  // Stage 3 enrichment line (PAR-3). Each field renders only when present
  // so pre-Stage-3 transcripts (which lack these fields entirely) collapse
  // the row exactly as before.
  const hasModelName = typeof turn.model_name === 'string' && turn.model_name.length > 0;
  const hasPosture =
    typeof turn.neurotype_posture === 'string' && turn.neurotype_posture.length > 0;
  const hasWordCount = typeof turn.word_count === 'number';
  // `convergence_delta` is special: an explicit `null` (round 1) must
  // render the em-dash; only `undefined` (legacy turn) hides the chip.
  const hasDelta = 'convergence_delta' in turn && turn.convergence_delta !== undefined;
  const showEnrichment = hasModelName || hasPosture || hasWordCount || hasDelta;

  const deltaValue = hasDelta ? turn.convergence_delta ?? null : null;
  const deltaLabel = formatConvergenceDelta(deltaValue);
  const deltaTone =
    deltaValue == null
      ? 'text-zinc-500'
      : deltaValue > 0
        ? 'text-emerald-300/80'
        : deltaValue < 0
          ? 'text-amber-300/80'
          : 'text-zinc-400';

  // PAR-24 — per-turn telemetry footer. Each field renders independently so
  // a fully-local turn (latency + tokens, no cost) collapses the cost chip
  // while still showing the rest, and a pre-PAR-23 turn (no `meta` at all)
  // collapses the entire row.
  const hasLatency = typeof turn.meta?.latencyMs === 'number';
  const hasTokens =
    typeof turn.meta?.promptTokens === 'number' &&
    typeof turn.meta?.completionTokens === 'number';
  const hasCost = typeof turn.meta?.costUsd === 'number';
  const hasProvider =
    typeof turn.meta?.provider === 'string' && turn.meta.provider.length > 0;
  const showMeta = hasLatency || hasTokens || hasCost || hasProvider;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay: index * 0.06, ease: 'easeOut' }}
      className="group relative"
    >
      <div
        className={`surface-interactive relative overflow-hidden rounded-xl p-4`}
      >
        {/* Colored top accent line */}
        <div
          className={`absolute inset-x-0 top-0 h-px bg-gradient-to-r ${style.gradient}`}
        />

        {/* Agent header */}
        <div className="mb-3">
          <span className={`inline-flex h-6 items-center gap-1.5 rounded-md px-2 text-2xs font-semibold ${style.badge}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${style.dot}`} />
            {style.label}
          </span>
          <p className="mt-1.5 truncate font-mono text-2xs text-zinc-500/70">
            {turn.model}
          </p>
        </div>

        {/* Content */}
        <p className="whitespace-pre-wrap text-[13px] leading-[1.7] text-zinc-300/90">
          {turn.content}
        </p>

        {/* Enrichment secondary line (PAR-3). Quiet, muted typography so it
             never competes with the transcript. Only renders when at least
             one Stage 3 field is present — pre-Stage-3 transcripts collapse
             this row entirely. */}
        {showEnrichment && (
          <div
            data-testid="turn-enrichment"
            className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-zinc-500"
          >
            {hasModelName && (
              <span
                className="font-mono text-zinc-500/80"
                title="model"
                aria-label={`model: ${turn.model_name}`}
              >
                {turn.model_name}
              </span>
            )}
            {hasPosture && (
              <span
                title={`neurotype: ${turn.neurotype}`}
                aria-label={`posture: ${turn.neurotype_posture} (neurotype: ${turn.neurotype})`}
              >
                {turn.neurotype_posture}
              </span>
            )}
            {hasWordCount && (
              <span
                className="tabular-nums text-zinc-500/80"
                title="word_count"
                aria-label={`word count: ${turn.word_count}`}
              >
                {turn.word_count} words
              </span>
            )}
            {hasDelta && (
              <span
                className={`tabular-nums ${deltaTone}`}
                title="convergence_delta"
                aria-label={
                  deltaValue == null
                    ? 'movement toward consensus: not measurable yet'
                    : `movement toward consensus: ${deltaLabel} (convergence_delta)`
                }
              >
                {deltaLabel}
              </span>
            )}
          </div>
        )}

        {/* Footer */}
        <div className="mt-3 flex items-center justify-between border-t border-white/[0.04] pt-2.5">
          <span className="text-2xs text-zinc-500">{time}</span>
          {turn.osi_score != null && (
            <span className="flex items-center gap-1.5 rounded-md bg-white/[0.03] px-1.5 py-0.5 text-2xs ring-1 ring-white/[0.04]">
              <span className="text-zinc-500">OSI</span>
              <span className={turn.osi_score > 0.15 ? 'text-amber-400' : 'text-zinc-400'}>
                {turn.osi_score.toFixed(3)}
              </span>
            </span>
          )}
        </div>

        {/* PAR-24 — per-turn telemetry footer (latency / tokens / cost /
             provider). Sits beneath the existing time/OSI footer, matching
             the muted enrichment-row aesthetic above. Each chip renders
             independently so a local-only turn collapses the cost chip and
             a pre-PAR-23 turn (no `meta`) collapses the whole row. */}
        {showMeta && (
          <div
            data-testid="turn-meta"
            className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-zinc-500"
          >
            {hasLatency && (
              <span
                className="tabular-nums text-zinc-500/80"
                title="latency"
                aria-label={`latency: ${formatLatencyMs(turn.meta!.latencyMs!)}`}
              >
                {formatLatencyMs(turn.meta!.latencyMs!)}
              </span>
            )}
            {hasTokens && (
              <span
                className="tabular-nums text-zinc-500/80"
                title="tokens (prompt → completion)"
                aria-label={`tokens: ${turn.meta!.promptTokens} prompt, ${turn.meta!.completionTokens} completion`}
              >
                {turn.meta!.promptTokens}
                {' \u2192 '}
                {turn.meta!.completionTokens}
              </span>
            )}
            {hasCost && (
              <span
                className="tabular-nums text-zinc-500/80"
                title="cost (USD)"
                aria-label={`cost: $${turn.meta!.costUsd!.toFixed(4)} USD`}
              >
                ${turn.meta!.costUsd!.toFixed(4)}
              </span>
            )}
            {hasProvider && (
              <span
                className="font-mono text-zinc-500/80"
                title="provider"
                aria-label={`provider: ${turn.meta!.provider}`}
              >
                {turn.meta!.provider}
              </span>
            )}
          </div>
        )}
      </div>
    </motion.div>
  );
}
