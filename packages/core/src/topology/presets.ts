import type { TopologyPreset } from './types.js';

/**
 * ----------------------------------------------------------------------------
 * Built-in preset registry
 * ----------------------------------------------------------------------------
 *
 * The single source of truth for preset IDs that ship with Parliament. The
 * topology loader merges these with any user-defined presets from
 * `parliament.toml`, with hard errors on ID collisions.
 *
 * Per the topology spec, every preset — built-in or user-defined — MUST
 * declare `name`, `description`, and `best_for`. There is no metadata-exempt
 * preset class.
 *
 * Step IDs are kebab-case per the spec's "Step IDs MUST be kebab-case" rule.
 * The `proposer` step is intentionally not marked `optional`; the engine's
 * round-1-only Proposer execution is a runtime concern, not a step-skip
 * concern.
 *
 * **Sentry is deliberately absent** from every preset's `steps` array.
 * Sentry runs out-of-band in the deliberation engine — it is structural
 * infrastructure, not a steppable neurotype, and the loader rejects any
 * preset that references it from `steps`.
 *
 * Stage 1 will likely add additional presets (`star-chamber`, etc.). Adding
 * one is mechanical: append a `TopologyPreset` entry to `BUILTIN_PRESETS`.
 * ----------------------------------------------------------------------------
 */

const DEBATE_PRESET: TopologyPreset = Object.freeze({
  id: 'debate',
  name: 'Debate',
  description:
    'The original two-voice deliberation: a Proposer opens, a Skeptic challenges, and the Synthesizer reconciles each round.',
  best_for:
    'Quick directional reads on a focused question where breadth of perspective matters less than fast convergence.',
  isBuiltin: true,
  steps: Object.freeze([
    Object.freeze({ id: 'proposer', neurotype: 'proposer', optional: false }),
    Object.freeze({ id: 'skeptic', neurotype: 'skeptic', optional: false }),
  ]),
});

/**
 * Built-in presets keyed by ID. Frozen so callers cannot mutate the registry
 * at runtime.
 */
export const BUILTIN_PRESETS: Readonly<Record<string, TopologyPreset>> = Object.freeze({
  debate: DEBATE_PRESET,
});

/** All built-in preset IDs in registration order. */
export const BUILTIN_PRESET_IDS: readonly string[] = Object.freeze(
  Object.keys(BUILTIN_PRESETS),
);

/** True when `id` resolves to a built-in preset. */
export function isBuiltinPreset(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(BUILTIN_PRESETS, id);
}
