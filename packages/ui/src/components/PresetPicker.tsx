import { useEffect, useMemo, useState } from 'react';
import { getPresets } from '../lib/api';
import type { PresetInfo } from '../lib/types';
import { PresetBadge } from './PresetBadge';

/**
 * Baked-in fallback used when `GET /presets` is unavailable.
 *
 * Order and IDs match the seven Stage-1/Stage-4 built-in presets registered
 * in `packages/core/src/topology`. Descriptions are intentionally short — the
 * server's authoritative copy replaces this list as soon as the endpoint
 * answers successfully.
 */
export const FALLBACK_PRESETS: PresetInfo[] = [
  {
    id: 'debate',
    name: 'Debate',
    description: 'Proposer vs. Skeptic with a Synthesizer reconciling.',
    best_for: 'Open-ended questions where competing positions need airing.',
  },
  {
    id: 'star-chamber',
    name: 'Star Chamber',
    description: 'Adversarial panel pressure-tests the proposal.',
    best_for: 'High-stakes decisions that benefit from hostile review.',
  },
  {
    id: 'chain-of-verifiers',
    name: 'Chain of Verifiers',
    description: 'Sequential verification passes catch errors before synthesis.',
    best_for: 'Factual claims that need staged checking.',
  },
  {
    id: 'socratic',
    name: 'Socratic',
    description: 'Question-driven elicitation surfaces hidden assumptions.',
    best_for: 'Ambiguous prompts that need interrogation before resolution.',
  },
  {
    id: 'long-view',
    name: 'Long View',
    description: 'Historian and Forecaster bracket the present argument.',
    best_for: 'Decisions sensitive to long horizons or precedent.',
  },
  {
    id: 'reframe',
    name: 'Reframe',
    description: 'Lateralist reframes before debate to break stuck framings.',
    best_for: 'Problems where the framing is the disagreement.',
  },
  {
    id: 'jury',
    name: 'Jury',
    description: 'Parallel independent panel votes; results merged in order.',
    best_for: 'When breadth of independent opinion matters more than dialogue.',
  },
];

export const FALLBACK_DEFAULT = 'debate';

interface Props {
  value: string;
  onChange: (next: string) => void;
  /**
   * Disable user interaction while a deliberation is running. The component
   * still renders so the user can see which preset is active.
   */
  disabled?: boolean;
}

interface LoadState {
  presets: PresetInfo[];
  defaultPreset: string;
  loading: boolean;
  /** Set when a fetch failed or returned an unexpected shape. */
  fellBack: boolean;
}

const INITIAL_STATE: LoadState = {
  presets: FALLBACK_PRESETS,
  defaultPreset: FALLBACK_DEFAULT,
  loading: true,
  fellBack: false,
};

/**
 * Dropdown picker for topology presets.
 *
 * Behaviour:
 * - Fetches `/presets` on mount; falls back to `FALLBACK_PRESETS` on any error
 *   so the form stays usable while PAR-7 lands or the server is offline.
 * - When the parent has not yet selected a value, this component bumps it to
 *   the server's `defaultPreset` (or `FALLBACK_DEFAULT`) via `onChange`.
 * - Presets whose `missing_neurotypes` is non-empty are rendered but disabled,
 *   with a `title` tooltip naming the missing neurotype IDs.
 */
export function PresetPicker({ value, onChange, disabled = false }: Props) {
  const [state, setState] = useState<LoadState>(INITIAL_STATE);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setState((prev) => ({ ...prev, loading: true }));

    getPresets(controller.signal)
      .then((res) => {
        if (cancelled) return;
        const presets = Array.isArray(res?.presets) && res.presets.length > 0
          ? res.presets
          : FALLBACK_PRESETS;
        const defaultPreset =
          typeof res?.defaultPreset === 'string' && res.defaultPreset.length > 0
            ? res.defaultPreset
            : FALLBACK_DEFAULT;
        setState({
          presets,
          defaultPreset,
          loading: false,
          fellBack: presets === FALLBACK_PRESETS && !Array.isArray(res?.presets),
        });
      })
      .catch((err) => {
        if (cancelled || (err instanceof DOMException && err.name === 'AbortError')) {
          return;
        }
        setState({
          presets: FALLBACK_PRESETS,
          defaultPreset: FALLBACK_DEFAULT,
          loading: false,
          fellBack: true,
        });
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, []);

  // Once we know the resolved default, ensure the parent has a non-empty
  // value. We do not override an explicit user selection.
  useEffect(() => {
    if (state.loading) return;
    if (value && state.presets.some((p) => p.id === value)) return;
    onChange(state.defaultPreset);
  }, [state, value, onChange]);

  const presetById = useMemo(() => {
    const map = new Map<string, PresetInfo>();
    for (const preset of state.presets) map.set(preset.id, preset);
    return map;
  }, [state.presets]);

  const selected = presetById.get(value);
  const selectedDisabled =
    selected !== undefined &&
    Array.isArray(selected.missing_neurotypes) &&
    selected.missing_neurotypes.length > 0;

  function handleChange(next: string) {
    if (disabled) return;
    onChange(next);
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <label
          htmlFor="preset-picker"
          className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-zinc-400"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="text-parliament-400">
            <path
              d="M4 6h16M4 12h10M4 18h7"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
          Preset
        </label>
        {state.loading && (
          <span className="text-2xs uppercase tracking-wider text-zinc-500">
            Loading…
          </span>
        )}
        {state.fellBack && !state.loading && (
          <span
            className="text-2xs uppercase tracking-wider text-zinc-500"
            title="Couldn't reach /presets — showing built-in defaults."
          >
            Offline list
          </span>
        )}
      </div>

      <div className="relative">
        <select
          id="preset-picker"
          aria-label="Deliberation preset"
          value={value}
          disabled={disabled}
          onChange={(e) => handleChange(e.target.value)}
          className="w-full appearance-none rounded-xl border-0 bg-white/[0.03] px-4 py-3 pr-10 text-sm text-zinc-100 outline-none ring-1 ring-white/[0.06] transition-colors focus:bg-white/[0.05] focus:ring-parliament-400/30 disabled:opacity-40"
        >
          {state.presets.map((preset) => {
            const isMissing =
              Array.isArray(preset.missing_neurotypes) && preset.missing_neurotypes.length > 0;
            return (
              <option
                key={preset.id}
                value={preset.id}
                disabled={isMissing}
                aria-disabled={isMissing}
                title={
                  isMissing
                    ? `Unavailable — missing neurotypes: ${preset.missing_neurotypes!.join(', ')}`
                    : preset.description
                }
              >
                {preset.name}
                {isMissing ? ' (unavailable)' : ''} — {preset.description}
              </option>
            );
          })}
        </select>

        {/* Caret */}
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
          className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500"
        >
          <path
            d="M6 9l6 6 6-6"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>

      {/* PAR-20: per-preset color chips. Each available preset shows up
          here so the user can preview the same color identity they'll
          see on the result-view header and the deliberation list after
          submit. Disabled (missing-neurotype) presets stay visible but
          dimmed; clicking a chip is a one-tap shortcut to selection. */}
      <div
        data-testid="preset-chip-row"
        className="flex flex-wrap items-center gap-1.5"
      >
        {state.presets.map((preset) => {
          const isMissing =
            Array.isArray(preset.missing_neurotypes) &&
            preset.missing_neurotypes.length > 0;
          const isSelected = preset.id === value;
          return (
            <button
              key={preset.id}
              type="button"
              onClick={() => !isMissing && handleChange(preset.id)}
              disabled={disabled || isMissing}
              aria-pressed={isSelected}
              title={
                isMissing
                  ? `Unavailable — missing neurotypes: ${preset.missing_neurotypes!.join(', ')}`
                  : preset.description
              }
              className={`rounded-md transition-opacity ${
                isMissing
                  ? 'cursor-not-allowed opacity-30'
                  : 'cursor-pointer hover:opacity-100'
              } ${isSelected ? 'opacity-100 ring-1 ring-white/20' : 'opacity-70'}`}
            >
              <PresetBadge presetId={preset.id} name={preset.name} />
            </button>
          );
        })}
      </div>

      {selected && (
        <div
          className={`flex items-center gap-2 text-xs ${
            selectedDisabled ? 'text-rose-300/80' : 'text-zinc-500'
          }`}
          data-testid="preset-best-for"
        >
          {/* PAR-20: prominent chip echoing the selected preset's color
              so the pre-submit picker matches the post-submit list +
              header chip exactly. */}
          <PresetBadge presetId={selected.id} name={selected.name} />
          {selectedDisabled ? (
            <span>
              Missing neurotypes: {selected.missing_neurotypes!.join(', ')}. Choose another preset.
            </span>
          ) : (
            <span>
              <span className="text-zinc-400">Best for:</span> {selected.best_for}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
