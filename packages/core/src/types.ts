export type TerminationReason =
  | 'consensus'
  | 'echo_loop'
  | 'max_rounds'
  | 'red_agent_triggered';

export type SentrySignal = 'ok' | 'specialist_needed' | 'collapse_detected';

/**
 * Lifecycle status of a deliberation row as observed by callers reading
 * `GET /deliberate/:id` (PAR-18). The synchronous `runTopology()` path keeps
 * returning a fully-populated `DeliberationResult`; the server layer mints
 * an id on submit, persists a placeholder row with `status: 'in_flight'`,
 * appends turns progressively, and flips the row to `completed` (or
 * `failed`) once the engine terminates.
 *
 * Additive: pre-PAR-18 stored deliberations and old client builds that lack
 * any awareness of `status` continue to render `completed` runs unchanged
 * because every existing field stays populated.
 */
export type DeliberationStatus = 'in_flight' | 'completed' | 'failed';

/**
 * A single, structured, labeled source attached to a deliberation (PAR-17).
 *
 * Unlike PAR-16's free-form `context` blob, sources are first-class evidence
 * the engine exposes to every non-Sentry agent's user prompt under a stable
 * `## Sources` heading. Agents are instructed to cite a source by its
 * `[id]` — the user-provided id, NOT the array index — so citations stay
 * stable across regenerations and downstream tooling (which the engine does
 * NOT enforce; it only exposes the contract) can validate them.
 *
 * Field semantics:
 *   - `id`: short, human-meaningful identifier the agent will quote in
 *     `[brackets]`. The CLI derives this from the file basename
 *     (e.g. `foo-2024.md` → `foo-2024`); the UI / API client accepts whatever
 *     the caller supplies. Non-empty.
 *   - `title`: human-readable display name shown in the UI Sources panel
 *     (e.g. "Foo et al. 2024 — Title"). Non-empty.
 *   - `content`: pre-extracted plain text. Tool-use / on-demand retrieval is
 *     out of scope; this ticket assumes the caller has already pulled the
 *     prose. Per-source word cap is applied at prompt-construction time
 *     (default 500 words; configurable via
 *     `DeliberationConfig.maxSourceWords`). Non-empty.
 *   - `kind`: optional taxonomy label rendered as a chip in the UI and as a
 *     parenthesized hint in the prompt header. Free enum — `paper` |
 *     `memo` | `code` | `transcript` | `other`.
 *
 * Additive / fully optional: existing callers that omit `sources` see no
 * behaviour change. Sources can coexist with PAR-16 `context`; the prompt
 * builder emits both (context first, then sources) when both are present.
 */
export interface DeliberationSource {
  id: string;
  title: string;
  content: string;
  kind?: 'paper' | 'memo' | 'code' | 'transcript' | 'other';
}

/**
 * Structured signal emitted by the SynthesizerAgent alongside its prose summary.
 * Carries the model's calibrated certainty (`confidence`), its own self-reported
 * judgement on whether the debate has resolved (`consensus`), and short
 * bullet-string lists of the points that have / have not been resolved.
 *
 * Only the synthesizer populates `Turn.meta`; for all other agents it is
 * absent.
 */
export interface SynthesizerMeta {
  /** Calibrated certainty in the synthesis, in [0, 1]. */
  confidence: number;
  /** Synthesizer's own judgement on whether the debate has resolved. */
  consensus: boolean;
  /** Short bullet strings (~10 words each) the agents agree on. */
  agreed: string[];
  /** Short bullet strings (~10 words each) that remain unresolved. */
  unresolved: string[];
}

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
   * Whitespace-delimited word count of `content`, populated by the engine when
   * the turn is recorded. Stage 3 UI surfaces this directly; downstream
   * consumers (the Timeline word-budget badge, transcript exporters) MUST
   * trust this value rather than recomputing it from `content`.
   *
   * Optional for backward-compat with already-recorded transcripts that
   * pre-date the topology runtime; new turns the engine appends always
   * populate it.
   */
  word_count?: number;
  /**
   * Stable observability echo of `model`. The Stage 3 Observability UI binds
   * the Timeline turn-card "model" badge to this field rather than to the
   * legacy `model` field so the wire-name stays decoupled from the engine's
   * internal field name. Always populated by the engine on freshly recorded
   * turns; pre-Stage-3 transcripts may omit it (the server falls back to
   * echoing `model` when the field is absent).
   *
   * PAR-10 — see `openspec/changes/add-observability-ui/specs/observability-ui/spec.md`.
   * Additive: the legacy `model` field MUST NOT be removed or renamed.
   */
  model_name?: string;
  /**
   * Short plain-language posture label for the agent that produced this turn
   * (e.g. "evidence-first" for Empiricist, "adversarial" for Skeptic,
   * "reconciliation" for Synthesizer). The Stage 3 Timeline turn-card surfaces
   * this directly so users can read a posture without decoding the
   * neurotype ID. When the agent does not declare a posture, the engine
   * defaults to echoing `neurotype` so the field is always populated for
   * fresh turns. Pre-Stage-3 transcripts may omit it.
   *
   * PAR-10 — additive observability enrichment.
   */
  neurotype_posture?: string;
  /**
   * Engine-attached convergence delta for this turn — how the synthesizer's
   * confidence shifted between the two prior rounds:
   *   delta(R) = synth_confidence(R-1) - synth_confidence(R-2)
   *
   * The engine writes 0 when the delta is not measurable (round 1, or when
   * the prior round produced no synthesizer turn). Round 1 turns therefore
   * always carry 0 here; the server response layer translates 0 to `null`
   * for the Timeline "no movement yet" rendering, which is why this field
   * accepts `null` as well — the server's `EnrichedTurn` extension narrows
   * to `number | null`. See
   * `packages/server/src/routes.ts#computeConvergenceDelta`.
   *
   * PAR-10 — additive observability enrichment.
   */
  convergence_delta?: number | null;
  /** Populated by SynthesizerAgent only — structured signals next to the prose. */
  meta?: SynthesizerMeta;
  /**
   * PAR-19 — per-round residue value, populated ONLY on synthesizer turns at
   * the end of each round. Carries the same weighted-fraction-of-unresolved-
   * conflicts signal as `DeliberationResult.residueScore`, but evaluated
   * against the blackboard's conflicts state immediately after the
   * synthesizer fires for that round. Always in `[0, 1]`.
   *
   * The Stage 3 Observability panel binds its "Disagreement remaining"
   * per-round bar chart directly to this field (grouping turns by round and
   * reading the synthesizer turn's value), replacing the PAR-5 placeholder
   * that derived a proxy from `|convergence_delta|`.
   *
   * Optional / additive: only synthesizer turns populate it; all other turn
   * types leave it `undefined`. Pre-PAR-19 stored transcripts also omit it
   * — UI consumers must fall back to the legacy proxy in that case so old
   * deliberations keep rendering. The end-of-run scalar `residueScore` on
   * `DeliberationResult` is preserved unchanged.
   */
  residue_remaining?: number;
  /**
   * Group identifier shared by all sibling turns produced inside the same
   * `parallel_steps` block. Sequential turns either omit this field or set it
   * to `null`. Stage 4 (add-jury-parallel) — see
   * `openspec/changes/add-jury-parallel/specs/topology-parallel/spec.md`.
   */
  parallel_group?: string | null;
}

export interface Conflict {
  between: string[];
  description: string;
  resolved: boolean;
}

/**
 * Legacy result type used by the original runDebate() function.
 * New code should use DeliberationResult from the DeliberationEngine.
 */
export interface DebateResult {
  topic: string;
  turns: Turn[];
  conflicts: Conflict[];
  residue: string[];
  resolved: boolean;
  total_rounds: number;
  termination_reason: TerminationReason;
}

export interface SplitSummary {
  positions: Record<string, string>;
  irreconcilable: boolean;
}

/**
 * Canonical kinds for `SystemEvent`. The Stage 3 Observability UI keys
 * rendering decisions off these values; every kind that can appear in a fresh
 * deliberation is enumerated here so type-narrowing on the UI side is
 * exhaustive.
 *
 * Two families exist, kept on a single union to preserve the additive
 * backward-compat contract:
 *
 *   1. **Intervention kinds** — predate PAR-10 and cover engine interventions
 *      that the Observability panel originally surfaced:
 *        - `red_agent.injection` — RedAgent fired at the configured interval.
 *          The RedAgent's content is also recorded as a turn; the event is
 *          the out-of-band marker for the panel's chronological list.
 *        - `sentry.echo` — Sentry returned `collapse_detected`, terminating
 *          the deliberation with `echo_loop`. No corresponding turn is
 *          recorded (Sentry never produces transcript prose).
 *
 *   2. **Lifecycle kinds** — added in PAR-10 so the panel can render a
 *      proper round/parallel/synthesis timeline without inferring boundaries
 *      from turn ordering. Lifecycle kinds are diagnostic — old client
 *      builds that filter the events array to only the original two kinds
 *      keep working unchanged.
 *        - `round_start` / `round_end` — boundary markers for each
 *          deliberation round.
 *        - `parallel_block_start` / `parallel_block_end` — markers around
 *          a `parallel_steps` block (Jury preset). Carry the block's
 *          `parallel_group` UUID in `data` so siblings can be cross-linked
 *          to their group marker.
 *        - `synthesis_attempt` — emitted whenever the synthesizer runs,
 *          regardless of whether consensus was reached. Carries
 *          `{ confidence, consensus }` in `data`.
 *        - `consensus_reached` — emitted when the synthesizer's vote +
 *          confidence cross the configured threshold and the round
 *          terminates with `terminationReason = "consensus"`.
 *        - `termination` — emitted exactly once at deliberation end with
 *          `{ reason, totalRounds }` in `data` so the panel can render an
 *          "ended at round N — reason" summary without reading the result
 *          fields directly.
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
 * Out-of-band events the engine records alongside the turn stream. These are
 * NOT turns themselves — they capture engine-level interventions (RedAgent
 * injections, Sentry warnings) and engine lifecycle markers (round and
 * parallel-block boundaries, synthesis attempts, termination) that the
 * Stage 3 Observability UI surfaces in the event list.
 *
 * Both the legacy `red_agent.injection` / `sentry.echo` shape and the new
 * lifecycle kinds (PAR-10) carry the same three core fields (`round`, `kind`,
 * `message`), so old client builds that filter on those fields keep working.
 * Lifecycle kinds also populate the optional `data` payload and `timestamp`
 * fields where the UI needs structured context.
 */
export interface SystemEvent {
  /** 1-indexed round in which the event fired. */
  round: number;
  /** Discriminator for the event source. See `SystemEventKind` for taxonomy. */
  kind: SystemEventKind;
  /** Human-readable description for the Observability panel's event list. */
  message: string;
  /**
   * ISO8601 timestamp captured when the engine emitted the event. Optional
   * for backward-compat with stored deliberations recorded before PAR-10
   * (those rows have only `round`, `kind`, `message`).
   */
  timestamp?: string;
  /**
   * Kind-specific structured payload. Optional and free-form so each
   * lifecycle kind can carry the data the UI needs without coupling the
   * UI to a strict per-kind type. Examples (non-exhaustive):
   *   - `parallel_block_start` / `parallel_block_end` →
   *     `{ parallel_group: string, step_count: number }`
   *   - `synthesis_attempt` → `{ confidence: number, consensus: boolean }`
   *   - `termination` → `{ reason: TerminationReason, totalRounds: number }`
   */
  data?: unknown;
}

/** Result produced by DeliberationEngine.run(). */
export interface DeliberationResult {
  topic: string;
  /**
   * Topology preset id that produced this deliberation (e.g. `debate`,
   * `star-chamber`, `jury`). Populated by `runTopology()` from
   * `topology.activePreset.id` so downstream consumers can render a
   * per-preset visual marker (PAR-20) without re-deriving the preset from
   * the turn order.
   *
   * Additive: stored deliberations recorded before PAR-20 omit this field;
   * the legacy `run()` path also leaves it absent because that pipeline
   * predates the topology runtime. UI consumers MUST treat it as optional
   * and fall back to a neutral badge when missing.
   */
  preset?: string;
  /**
   * Optional free-form prose context the user supplied alongside the topic
   * (PAR-16). When present, the engine prepends it to every non-Sentry
   * agent's user-message turn under a `## Background` heading so each agent
   * starts with the same brief. Echoed back verbatim on `POST /deliberate`
   * and persisted on the deliberation record so `GET /deliberate/:id`
   * round-trips it unchanged.
   *
   * Additive: stored deliberations recorded before PAR-16 omit this field;
   * old client builds keep parsing because no existing field is renamed
   * or removed.
   */
  context?: string;
  /**
   * Optional structured sources the user supplied alongside the topic
   * (PAR-17). When non-empty, the engine renders them under a stable
   * `## Sources` heading on every non-Sentry agent's user prompt and instructs
   * agents to cite by `[id]`. Echoed back unchanged on `POST /deliberate` and
   * persisted on the deliberation record so `GET /deliberate/:id` round-trips
   * them. Coexists with `context` — both can be present.
   *
   * Additive: stored deliberations recorded before PAR-17 omit this field;
   * old client builds keep parsing.
   */
  sources?: DeliberationSource[];
  turns: Turn[];
  conflicts: Conflict[];
  /** Weighted fraction of unresolved conflicts, 0–1. 0 = all resolved. */
  residueScore: number;
  resolved: boolean;
  /** Synthesizer's final reconciled text, or null when split. */
  synthesis: string | null;
  /** Populated when synthesis is null (irreconcilable split). */
  split: SplitSummary | null;
  terminationReason: TerminationReason;
  totalRounds: number;
  /** ISO8601 timestamp captured at the start of run(). */
  started_at: string;
  /** ISO8601 timestamp captured immediately before run() returns. */
  completed_at: string;
  /**
   * Out-of-band system events captured during deliberation. Empty array when
   * no RedAgent injection or Sentry warning fired. See `SystemEvent` for the
   * recorded kinds. Stage 3 Observability UI consumes this directly.
   */
  events: SystemEvent[];
  /**
   * PAR-18 — lifecycle status surfaced on `GET /deliberate/:id`. Set by the
   * server (not the engine) so the engine return shape stays a snapshot of a
   * single completed run; the server layer flips a placeholder row from
   * `in_flight` to `completed` once `runTopology()` resolves and to `failed`
   * if it throws. The engine itself populates this as `completed` on its own
   * return value so a direct caller (CLI, tests) reading the result still
   * sees a coherent status.
   *
   * Optional / additive — pre-PAR-18 stored deliberations and old client
   * builds without status awareness continue parsing because no existing
   * field is renamed or removed; consumers that don't read `status` keep
   * rendering completed runs from the existing fields.
   */
  status?: DeliberationStatus;
  /**
   * PAR-18 — error message captured when a background `runTopology()` run
   * throws. Only populated alongside `status: 'failed'`. Pre-PAR-18 rows
   * lack this field; consumers must treat it as optional.
   */
  error?: string;
}

export interface Blackboard {
  topic: string;
  /**
   * Optional free-form prose context (PAR-16). The engine writes the
   * deliberation's user-supplied `context` here at run start so every
   * non-Sentry agent's prompt builder can prepend it to its user message
   * via `buildPromptHeader`. Carried separately from `metadata` to keep
   * the type strongly typed and to keep the back-compat surface narrow —
   * agents that ignore it continue working unchanged.
   *
   * Optional for back-compat with existing test mocks that construct
   * `Blackboard` literals without context.
   */
  context?: string;
  /**
   * Optional structured sources (PAR-17). The engine writes the deliberation's
   * user-supplied `sources` here at run start (after applying the per-source
   * word cap) so every non-Sentry agent's prompt builder can render the same
   * `## Sources` block and so the Empiricist can flip into evidence-backed
   * mode. Optional for back-compat with test mocks that construct
   * `Blackboard` literals without sources.
   */
  sources?: DeliberationSource[];
  turns: Turn[];
  conflicts: Conflict[];
  metadata: Record<string, unknown>;
}
