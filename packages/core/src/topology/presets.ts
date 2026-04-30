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

const STAR_CHAMBER_PRESET: TopologyPreset = Object.freeze({
  id: 'star-chamber',
  name: 'Star Chamber',
  description:
    'A Proposer opens and is then interrogated in turn by three distinct critics — Skeptic, Devils-Advocate, and Empiricist — before the Synthesizer reconciles the round.',
  best_for:
    'Questions where multiple critique angles need to fire before synthesis: combining logical, adversarial, and evidence-based scrutiny against a single proposal.',
  isBuiltin: true,
  steps: Object.freeze([
    Object.freeze({ id: 'proposer', neurotype: 'proposer', optional: false }),
    Object.freeze({ id: 'skeptic', neurotype: 'skeptic', optional: false }),
    Object.freeze({ id: 'devils-advocate', neurotype: 'devils-advocate', optional: false }),
    Object.freeze({ id: 'empiricist', neurotype: 'empiricist', optional: false }),
  ]),
});

const CHAIN_OF_VERIFIERS_PRESET: TopologyPreset = Object.freeze({
  id: 'chain-of-verifiers',
  name: 'Chain-of-Verifiers',
  description:
    'A sequence of verifiers each apply a different quality check to the Proposer: Empiricist demands evidence, Steelmanner restates charitably, Skeptic applies logic.',
  best_for:
    'Factual claims or arguments where evidence-then-charity-then-logic is the natural review order.',
  isBuiltin: true,
  steps: Object.freeze([
    Object.freeze({ id: 'proposer', neurotype: 'proposer', optional: false }),
    Object.freeze({ id: 'empiricist', neurotype: 'empiricist', optional: false }),
    Object.freeze({ id: 'steelmanner', neurotype: 'steelmanner', optional: false }),
    Object.freeze({ id: 'skeptic', neurotype: 'skeptic', optional: false }),
  ]),
});

const SOCRATIC_PRESET: TopologyPreset = Object.freeze({
  id: 'socratic',
  name: 'Socratic',
  description:
    'No Proposer at the head: the Translator opens by surfacing implicit assumptions in the user-supplied topic, the Empiricist demands evidence, the Skeptic applies logical scrutiny, and the Synthesizer reconciles.',
  best_for:
    'Questions where the user wants their OWN claim dissected, not a pre-existing thesis defended.',
  isBuiltin: true,
  steps: Object.freeze([
    Object.freeze({ id: 'translator', neurotype: 'translator', optional: false }),
    Object.freeze({ id: 'empiricist', neurotype: 'empiricist', optional: false }),
    Object.freeze({ id: 'skeptic', neurotype: 'skeptic', optional: false }),
  ]),
});

const LONG_VIEW_PRESET: TopologyPreset = Object.freeze({
  id: 'long-view',
  name: 'Long-View',
  description:
    'A temporally-aware deliberation: the Historian frames past precedent, the Proposer asserts the present claim, the Forecaster projects forward, and the Pragmatist constrains by what is feasible before synthesis.',
  best_for:
    'Strategic or policy questions where time-horizon matters and decisions must be situated against past precedent and future projection.',
  isBuiltin: true,
  steps: Object.freeze([
    Object.freeze({ id: 'historian', neurotype: 'historian', optional: false }),
    Object.freeze({ id: 'proposer', neurotype: 'proposer', optional: false }),
    Object.freeze({ id: 'forecaster', neurotype: 'forecaster', optional: false }),
    Object.freeze({ id: 'pragmatist', neurotype: 'pragmatist', optional: false }),
  ]),
});

const REFRAME_PRESET: TopologyPreset = Object.freeze({
  id: 'reframe',
  name: 'Reframe',
  description:
    'A deliberation that introduces analogy, surfaces assumptions, and charitably opposes before synthesizing: the Lateralist reframes by analogy, the Translator surfaces hidden assumptions, the Steelmanner builds the strongest opposing case, and the Synthesizer reconciles.',
  best_for:
    'Questions where the framing seems wrong but you cannot say why — helps surface alternative framings before committing to a critique.',
  isBuiltin: true,
  steps: Object.freeze([
    Object.freeze({ id: 'lateralist', neurotype: 'lateralist', optional: false }),
    Object.freeze({ id: 'translator', neurotype: 'translator', optional: false }),
    Object.freeze({ id: 'steelmanner', neurotype: 'steelmanner', optional: false }),
  ]),
});

/**
 * Jury — Stage 4 (add-jury-parallel). Proposer opens, then four critics fire
 * concurrently against the SAME read-only blackboard snapshot, then the
 * Synthesizer reconciles. The parallel block breaks the order-bias problem
 * the sequential `star-chamber` preset can't avoid: in Star Chamber the
 * Skeptic's framing is read by the Devils-Advocate, which is then read by the
 * Empiricist, etc. — the first critic dominates the room.
 *
 * Critic count is fixed at 4 per the elaboration decision on task `e5781f6d`.
 * Users wanting 3 or 5 critics author their own user-defined preset with
 * `parallel_steps`.
 */
const JURY_PRESET: TopologyPreset = Object.freeze({
  id: 'jury',
  name: 'Jury',
  description:
    'A Proposer opens, then four independent critics fire concurrently — Skeptic, Empiricist, Steelmanner, Devil\'s Advocate — each reading the same blackboard with no knowledge of the others, before the Synthesizer reconciles. Breaks the order-bias of sequential critic chains.',
  best_for:
    'Questions where you don\'t want the first speaker\'s framing to dominate the room — the four parallel critics each bring an independent angle to the same proposal.',
  isBuiltin: true,
  steps: Object.freeze([
    Object.freeze({ id: 'proposer', neurotype: 'proposer', optional: false }),
  ]),
  parallel_steps: Object.freeze([
    Object.freeze({ id: 'skeptic', neurotype: 'skeptic', optional: false }),
    Object.freeze({ id: 'empiricist', neurotype: 'empiricist', optional: false }),
    Object.freeze({ id: 'steelmanner', neurotype: 'steelmanner', optional: false }),
    Object.freeze({ id: 'devils-advocate', neurotype: 'devils-advocate', optional: false }),
  ]),
});

/**
 * Built-in presets keyed by ID. Frozen so callers cannot mutate the registry
 * at runtime.
 */
export const BUILTIN_PRESETS: Readonly<Record<string, TopologyPreset>> = Object.freeze({
  debate: DEBATE_PRESET,
  'star-chamber': STAR_CHAMBER_PRESET,
  'chain-of-verifiers': CHAIN_OF_VERIFIERS_PRESET,
  socratic: SOCRATIC_PRESET,
  'long-view': LONG_VIEW_PRESET,
  reframe: REFRAME_PRESET,
  jury: JURY_PRESET,
});

/** All built-in preset IDs in registration order. */
export const BUILTIN_PRESET_IDS: readonly string[] = Object.freeze(
  Object.keys(BUILTIN_PRESETS),
);

/** True when `id` resolves to a built-in preset. */
export function isBuiltinPreset(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(BUILTIN_PRESETS, id);
}
