export type TerminationReason =
  | 'consensus'
  | 'echo_loop'
  | 'max_rounds'
  | 'red_agent_triggered';

export interface Turn {
  agent: string;
  neurotype: string;
  model: string;
  content: string;
  timestamp: string;
  /** 1-indexed round number assigned by the engine when this turn was recorded. */
  round: number;
  osi_score?: number;
  /**
   * PAR-10 enrichment — wire-stable echo of the model identifier surfaced
   * by the Stage 3 Timeline turn-card model badge. Pre-Stage-3 transcripts
   * may omit this field; consumers must fall back to `model` (or hide the
   * badge) when absent. Kept additive — `model` is NOT renamed.
   */
  model_name?: string;
  /**
   * PAR-10 enrichment — short plain-language posture label for the agent
   * (e.g. "evidence-first", "adversarial", "reconciliation"). Surfaced on
   * the turn-card secondary line. Pre-Stage-3 transcripts may omit this
   * field; consumers must hide the chip when absent.
   */
  neurotype_posture?: string;
  /**
   * PAR-10 enrichment — whitespace-delimited word count of `content`,
   * trusted as engine-supplied. Pre-Stage-3 transcripts may omit this
   * field; the turn-card hides the badge in that case rather than
   * recomputing.
   */
  word_count?: number;
  /**
   * PAR-10 enrichment — sign-aware convergence delta between the two prior
   * synthesizer rounds. The server's `EnrichedTurn` narrows the engine's
   * `0`-when-unmeasurable convention to `null` so the UI can render
   * `—` for round-1 / no-prior-synthesis turns. Pre-Stage-3 transcripts
   * may omit the field entirely (the badge hides in that case). The Stage 3
   * Observability panel also binds to this field for the confidence sparkline.
   */
  convergence_delta?: number | null;
  /**
   * Group identifier shared by all sibling turns produced inside the same
   * `parallel_steps` block (Stage 4 — Jury preset). Sequential turns either
   * omit this field or set it to `null`. Mirrors the engine `Turn` type in
   * `packages/core/src/types.ts`. The Timeline groups consecutive turns that
   * share this id into a single sibling row. Optional / additive — pre-Stage-4
   * transcripts omit it and continue rendering as a vertical stack.
   */
  parallel_group?: string | null;
}

/**
 * Mirrors `SystemEventKind` from `@parliament/core`. Kept as a string union so
 * the UI can render unknown lifecycle kinds without type-narrowing breakage —
 * any future kind added by the engine still parses.
 */
export type SystemEventKind =
  | 'red_agent.injection'
  | 'sentry.echo'
  | 'round_start'
  | 'round_end'
  | 'parallel_block_start'
  | 'parallel_block_end'
  | 'synthesis_attempt'
  | 'consensus_reached'
  | 'termination';

/**
 * Out-of-band engine event surfaced by the Stage 3 Observability panel.
 * Mirrors the server-side shape; the panel only requires `round`, `kind`,
 * `message` to render — `timestamp` and `data` are optional for back-compat
 * with stored deliberations recorded before PAR-10.
 */
export interface SystemEvent {
  round: number;
  kind: SystemEventKind;
  message: string;
  timestamp?: string;
  data?: unknown;
}

export interface Conflict {
  between: string[];
  description: string;
  resolved: boolean;
}

export interface SplitSummary {
  positions: Record<string, string>;
  irreconcilable: boolean;
}

export interface DeliberationResult {
  topic: string;
  /**
   * Optional free-form prose context the user supplied alongside the topic
   * (PAR-16). Echoed back unchanged on `POST /deliberate` and persisted on
   * the deliberation record so `GET /deliberate/:id` round-trips it.
   * Old server builds omit this field; UI consumers should treat it as
   * optional and render only when present.
   */
  context?: string;
  turns: Turn[];
  conflicts: Conflict[];
  residueScore: number;
  resolved: boolean;
  synthesis: string | null;
  split: SplitSummary | null;
  terminationReason: TerminationReason;
  totalRounds: number;
  /** ISO8601 timestamp captured at the start of the deliberation. */
  started_at: string;
  /** ISO8601 timestamp captured immediately before the deliberation returned. */
  completed_at: string;
  /**
   * Out-of-band system events captured during deliberation (PAR-10).
   * Optional for stored deliberations recorded before the events stream
   * landed; UI consumers should treat an absent field as `[]`.
   */
  events?: SystemEvent[];
}

export interface DeliberationCreated extends DeliberationResult {
  id: string;
}

export interface DeliberationSummary {
  id: string;
  topic: string;
  created_at: string;
  resolved: number;
  total_rounds: number;
  termination_reason: string;
}

export interface TranscriptFile {
  file: string;
  topic: string;
  created_at: string;
}

export type Role = 'proposer' | 'skeptic' | 'synthesizer' | 'redAgent' | 'sentry';

export interface PresetStepShape {
  id: string;
  neurotype: string;
  optional: boolean;
}

/**
 * Topology preset entry returned by `GET /presets`.
 *
 * Mirrors the server `EnrichedPreset` shape. Treated as additive — if the
 * server adds new fields, older UI builds must continue to render. Only
 * `id`, `name`, `description`, and `best_for` are required for the picker;
 * `requires_neurotypes` / `missing_neurotypes` drive the disabled state.
 */
export interface PresetInfo {
  id: string;
  name: string;
  description: string;
  best_for: string;
  isBuiltin?: boolean;
  steps?: PresetStepShape[];
  parallel_steps?: PresetStepShape[];
  requires_neurotypes?: string[];
  missing_neurotypes?: string[];
}

export interface PresetsResponse {
  presets: PresetInfo[];
  defaultPreset: string;
}
