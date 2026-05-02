export type TerminationReason =
  | 'consensus'
  | 'echo_loop'
  | 'max_rounds'
  | 'red_agent_triggered';

/**
 * PAR-18 — lifecycle status of a deliberation row, mirrored from
 * `@parliament/core`. `POST /deliberate` returns `{id, status: 'in_flight'}`
 * before the engine runs; `GET /deliberate/:id` flips to `completed`
 * (or `failed` with `error: <message>`) once the engine terminates. The
 * UI uses this to drive the polling/streaming decision and to render an
 * in-progress card during a live run. Old client builds without this
 * field continue to render `completed` runs unchanged.
 */
export type DeliberationStatus = 'in_flight' | 'completed' | 'failed';

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
  /**
   * PAR-19 — per-round residue value, populated ONLY on synthesizer turns at
   * the end of each round. Mirrors the engine `Turn.residue_remaining` field
   * in `packages/core/src/types.ts`. Always in `[0, 1]`.
   *
   * The Stage 3 Observability panel's "Disagreement remaining" per-round bar
   * chart binds to this field (grouping turns by round and reading the
   * synthesizer turn's value), replacing the PAR-5 placeholder that derived
   * a proxy from `|convergence_delta|`.
   *
   * Optional / additive — pre-PAR-19 stored transcripts (and non-synthesizer
   * turns) omit this field; UI consumers must fall back to the legacy proxy
   * when the entire transcript lacks the signal.
   */
  residue_remaining?: number;
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

/**
 * PAR-17 — single structured source attached to a deliberation. Mirrors the
 * engine `DeliberationSource` shape. The Sources panel renders one row per
 * entry: the `[id]` chip is what the agents quote in citations, `kind`
 * (when present) renders as a category chip, `title` is the human-readable
 * display name, and `content` is the truncated prose pulled into the prompt.
 *
 * Optional / additive — pre-PAR-17 deliberations omit this field entirely;
 * the panel hides itself in that case.
 */
export interface DeliberationSource {
  id: string;
  title: string;
  content: string;
  kind?: 'paper' | 'memo' | 'code' | 'transcript' | 'other';
}

export interface SplitSummary {
  positions: Record<string, string>;
  irreconcilable: boolean;
}

export interface DeliberationResult {
  topic: string;
  /**
   * PAR-20: topology preset id that produced this deliberation. Used by the
   * result-view header to render a per-preset color/badge so same-topic,
   * different-preset runs are visually distinct. Optional / additive — old
   * server builds and pre-PAR-20 stored deliberations omit this field; the
   * `<PresetBadge>` component renders a neutral fallback when missing.
   */
  preset?: string;
  /**
   * Optional free-form prose context the user supplied alongside the topic
   * (PAR-16). Echoed back unchanged on `POST /deliberate` and persisted on
   * the deliberation record so `GET /deliberate/:id` round-trips it.
   * Old server builds omit this field; UI consumers should treat it as
   * optional and render only when present.
   */
  context?: string;
  /**
   * Optional structured sources the user supplied alongside the topic
   * (PAR-17). Echoed back unchanged on `POST /deliberate` and persisted on
   * the deliberation record so `GET /deliberate/:id` round-trips them.
   * Old server builds omit this field; UI consumers must treat it as
   * optional and only render the Sources panel when non-empty.
   */
  sources?: DeliberationSource[];
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
  /**
   * PAR-18 — lifecycle status. Set to `'in_flight'` while the engine is
   * still running (server returns partial state with whatever turns have
   * landed so far), `'completed'` once the synthesizer's final turn is
   * persisted, or `'failed'` if the engine throws. Optional for old
   * server builds that predate PAR-18; the UI treats an absent value as
   * `'completed'` (the legacy synchronous behavior).
   */
  status?: DeliberationStatus;
  /**
   * PAR-18 — error message captured when a background `runTopology()` run
   * throws. Only populated alongside `status: 'failed'`. Optional and
   * additive.
   */
  error?: string;
}

/**
 * PAR-18 — minimal response shape returned by the new fire-and-forget
 * `POST /deliberate`. The server mints a UUID, persists a placeholder
 * row with `status: 'in_flight'`, kicks off the engine in the background,
 * and returns this body inside ~1s. The UI then polls
 * `GET /deliberate/:id` (or opens the SSE stream) to observe progress.
 *
 * Pre-PAR-18 server builds returned a fully-populated `DeliberationResult`
 * directly; this lighter shape stays compatible because the existing
 * caller path (`POST` → read `id` → store in localStorage) works the
 * same — only the surrounding fields disappeared, and the legacy `id`
 * inclusion is preserved.
 */
export interface DeliberationAccepted {
  id: string;
  status: DeliberationStatus;
}

export interface DeliberationSummary {
  id: string;
  topic: string;
  created_at: string;
  resolved: number;
  total_rounds: number;
  termination_reason: string;
  /**
   * PAR-18 — lifecycle status surfaced on the list so an in-flight
   * deliberation appears with a "running…" affordance instead of the
   * neutral completed badge. Optional / additive — old server builds
   * surface this as `'completed'` when populated, and consumers should
   * treat an absent value as `'completed'`.
   */
  status?: DeliberationStatus;
  /**
   * PAR-20: topology preset id (e.g. `debate`, `star-chamber`, `jury`) that
   * produced this deliberation. Drives the per-preset color/badge in the
   * deliberation list so same-topic, different-preset runs are visually
   * distinct. Optional / additive — old server builds and deliberations
   * recorded before PAR-20 omit (or send `null` for) this field; the UI
   * renders a neutral fallback badge in that case.
   */
  preset?: string | null;
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
