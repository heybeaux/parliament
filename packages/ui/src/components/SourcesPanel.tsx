import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type { DeliberationSource } from '../lib/types';

interface Props {
  sources: DeliberationSource[] | undefined;
}

/**
 * PAR-17 — Sources panel.
 *
 * Renders the deliberation's structured `sources[]` (when present) as a
 * collapsible card sitting between the topic hero and the Timeline turns.
 *
 * Design decisions:
 *   - Hidden entirely when `sources` is undefined / empty so pre-PAR-17
 *     deliberations keep rendering byte-identically. The component is a
 *     pure no-op in that case.
 *   - Collapsed by default. Sources can be long; we don't want them to push
 *     the first turn out of view. The header carries a count chip so users
 *     know one click away exists.
 *   - One row per source. Each row shows the bracketed `[id]` chip (the
 *     same identifier agents quote in citations), an optional `kind` chip,
 *     the human-readable title, and the truncated content. The engine has
 *     already applied the per-source word cap with a `... [truncated]`
 *     suffix; we render it as plain prose so the truncation marker reads
 *     naturally.
 *   - The row content uses `whitespace-pre-wrap` to preserve any line
 *     breaks the user supplied without forcing a markdown renderer.
 */
export function SourcesPanel({ sources }: Props) {
  const [open, setOpen] = useState(false);

  if (sources === undefined || sources.length === 0) {
    return null;
  }

  const count = sources.length;

  return (
    <motion.section
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="rounded-xl bg-white/[0.02] ring-1 ring-white/[0.06]"
      data-testid="sources-panel"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="sources-panel-content"
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-white/[0.02]"
      >
        <div className="flex items-center gap-2.5">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            className="text-parliament-400"
            aria-hidden="true"
          >
            <path
              d="M4 5h16v3H4zm0 6h16v3H4zm0 6h16v3H4z"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          </svg>
          <p className="text-2xs font-semibold uppercase tracking-widest text-zinc-400">
            Sources
          </p>
          <span
            className="rounded-full bg-white/[0.04] px-2 py-0.5 text-2xs font-semibold tabular-nums text-zinc-300 ring-1 ring-white/[0.06]"
            aria-label={`${count} source${count === 1 ? '' : 's'}`}
          >
            {count}
          </span>
        </div>
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          className={`text-zinc-500 transition-transform ${open ? 'rotate-180' : 'rotate-0'}`}
          aria-hidden="true"
        >
          <path
            d="M6 9l6 6 6-6"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id="sources-panel-content"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden border-t border-white/[0.04]"
          >
            <ul className="divide-y divide-white/[0.04]">
              {sources.map((src) => (
                <li
                  key={src.id}
                  className="px-4 py-3"
                  data-testid="sources-panel-row"
                >
                  <div className="mb-1.5 flex flex-wrap items-center gap-2">
                    <span
                      className="rounded-md bg-parliament-500/10 px-1.5 py-0.5 font-mono text-2xs font-semibold text-parliament-300 ring-1 ring-parliament-400/20"
                      data-testid="sources-panel-id"
                    >
                      [{src.id}]
                    </span>
                    {src.kind !== undefined && (
                      <span className="rounded-md bg-white/[0.04] px-1.5 py-0.5 text-2xs font-medium uppercase tracking-wider text-zinc-400 ring-1 ring-white/[0.06]">
                        {src.kind}
                      </span>
                    )}
                    <span className="text-sm font-medium text-zinc-100">
                      {src.title}
                    </span>
                  </div>
                  <p className="whitespace-pre-wrap text-xs leading-relaxed text-zinc-400">
                    {src.content}
                  </p>
                </li>
              ))}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.section>
  );
}
