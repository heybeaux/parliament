export type TerminationReason =
  | 'consensus'
  | 'echo_loop'
  | 'max_rounds'
  | 'red_agent_triggered';

export type SentrySignal = 'ok' | 'specialist_needed' | 'collapse_detected';

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
  /** Populated by SynthesizerAgent only — structured signals next to the prose. */
  meta?: SynthesizerMeta;
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
 * Out-of-band events the engine records alongside the turn stream. These are
 * NOT turns themselves — they capture engine-level interventions (RedAgent
 * injections) and infrastructure signals (Sentry echo-collapse warnings) that
 * the Stage 3 Observability UI surfaces in the event list.
 *
 * Kinds:
 *   - `red_agent.injection` — RedAgent fired at the configured interval. The
 *     RedAgent's content is also recorded as a turn; the event is the
 *     out-of-band marker for the panel's chronological list.
 *   - `sentry.echo` — Sentry returned `collapse_detected`, terminating the
 *     deliberation with `echo_loop`. No corresponding turn is recorded for
 *     this event (Sentry never produces transcript prose).
 */
export interface SystemEvent {
  /** 1-indexed round in which the event fired. */
  round: number;
  /** Discriminator for the event source. */
  kind: 'red_agent.injection' | 'sentry.echo';
  /** Human-readable description for the Observability panel's event list. */
  message: string;
}

/** Result produced by DeliberationEngine.run(). */
export interface DeliberationResult {
  topic: string;
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
}

export interface Blackboard {
  topic: string;
  turns: Turn[];
  conflicts: Conflict[];
  metadata: Record<string, unknown>;
}
