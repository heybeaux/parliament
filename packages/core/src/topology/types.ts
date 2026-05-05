/**
 * ----------------------------------------------------------------------------
 * Topology configuration types
 * ----------------------------------------------------------------------------
 *
 * These types are the single source of truth for the resolved shape of a
 * `parliament.toml` topology. They live in the core package because both the
 * loader (this directory) and the deliberation runtime (next task) consume
 * the same `TopologyConfig` object.
 *
 * Spec source: `openspec/changes/add-topology-spec/specs/topology/spec.md`.
 * ----------------------------------------------------------------------------
 */

/** Default temperature applied to user-defined neurotypes when omitted. */
export const DEFAULT_NEUROTYPE_TEMPERATURE = 0.7;

/** Built-in preset ID used when `[topology]` is absent from `parliament.toml`. */
export const FALLBACK_PRESET_ID = 'debate';

/**
 * A single step in a preset's sequential `steps` array.
 *
 * - `id` MUST be kebab-case (`/^[a-z][a-z0-9-]*$/`) and unique within the
 *   preset.
 * - `neurotype` MUST resolve to either a built-in neurotype factory (see
 *   `agents/registry.ts`) or a user-defined `[neurotypes.<id>]` entry.
 * - `optional` defaults to `false` (strict-by-default; see the topology spec).
 */
export interface TopologyStep {
  id: string;
  neurotype: string;
  optional: boolean;
}

/**
 * A resolved preset definition.
 *
 * Preset metadata (`name`, `description`, `best_for`) is required uniformly
 * across built-in and user-defined presets — see the topology spec's
 * "Every preset MUST declare required metadata" requirement.
 */
export interface TopologyPreset {
  /** Kebab-case preset identifier. Unique within the resolved config. */
  id: string;
  /** Human-readable display name (Stage 3 UI surfaces this). */
  name: string;
  /** One- or two-sentence description (Stage 3 UI surfaces this). */
  description: string;
  /** Audience hint — when this preset is the right pick. */
  best_for: string;
  /** Whether this preset originates from the built-in registry. */
  isBuiltin: boolean;
  /** Sequential step list. */
  steps: readonly TopologyStep[];
  /**
   * Optional parallel step block. When present, every entry executes
   * concurrently against a read-only blackboard snapshot taken at block
   * start. Stage 4 — see add-jury-parallel/specs/topology-parallel/spec.md.
   *
   * Step IDs across `steps` and `parallel_steps` MUST be globally unique
   * within the preset; the loader rejects collisions with
   * `duplicate_step_id`.
   */
  parallel_steps?: readonly TopologyStep[];
}

/**
 * A user-defined neurotype declaration (`[neurotypes.<id>]`).
 *
 * `model` is always required. `system_prompt` is required for *user-defined*
 * neurotypes (no class default exists for them) but optional for built-in
 * neurotypes — those fall back to the SYSTEM_PROMPT constant in their
 * `agents/<id>.ts` file when omitted (PAR-40). The loader enforces this
 * split: presence is checked only when `isBuiltinNeurotype(id)` is false.
 */
export interface UserNeurotypeConfig {
  /** Model adapter identifier — passed to the adapter factory at runtime. */
  model: string;
  /**
   * Posture-defining system prompt. Required for user-defined neurotype
   * IDs; optional for built-in IDs (the agent class supplies a default at
   * runtime when this field is absent).
   */
  system_prompt?: string;
  /** Optional human-readable description. */
  description?: string;
  /**
   * Sampling temperature. Defaults to `DEFAULT_NEUROTYPE_TEMPERATURE` (0.7)
   * when omitted from the TOML.
   */
  temperature: number;
  /** Provider override; inherits the global default when omitted. */
  provider?: string;
}

/**
 * The fully-resolved topology configuration handed to the deliberation
 * runtime.
 *
 * - `activePreset` is guaranteed to exist in `presets`. The loader resolves
 *   the configured `active` against built-ins + user-defined and either
 *   succeeds with this object or throws.
 * - `presets` is keyed by preset ID and includes BOTH built-ins and
 *   user-defined presets. User-defined entries that collide with built-in
 *   IDs are a hard error, mirroring the user-defined-neurotype rule.
 * - `userNeurotypes` mirrors the `[neurotypes.<id>]` user-defined registry.
 *   Built-in neurotypes are NOT duplicated here — the runtime resolves
 *   built-ins via `BUILTIN_AGENT_REGISTRY` first and falls back to this map.
 */
export interface TopologyConfig {
  activePreset: TopologyPreset;
  presets: Readonly<Record<string, TopologyPreset>>;
  userNeurotypes: Readonly<Record<string, UserNeurotypeConfig>>;
}

/**
 * Validation error thrown by the loader. The `code` field is stable for
 * downstream consumers (CLI, server) that want to render different UIs per
 * failure class.
 */
export class TopologyValidationError extends Error {
  readonly code: TopologyValidationCode;
  constructor(code: TopologyValidationCode, message: string) {
    super(message);
    this.name = 'TopologyValidationError';
    this.code = code;
  }
}

export type TopologyValidationCode =
  | 'missing_metadata'
  | 'duplicate_step_id'
  | 'invalid_step_id_format'
  | 'unknown_neurotype'
  | 'unknown_active_preset'
  | 'sentry_in_steps'
  | 'preset_id_collision'
  | 'invalid_preset_shape'
  | 'invalid_neurotype_shape'
  | 'invalid_topology_shape';

/** Logger sink the loader emits structured info-level messages through. */
export interface TopologyLogger {
  info(message: string): void;
}
