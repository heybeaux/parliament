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
}

export interface Blackboard {
  topic: string;
  turns: Turn[];
  conflicts: Conflict[];
  metadata: Record<string, unknown>;
}
