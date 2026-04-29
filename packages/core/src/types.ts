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
  osi_score?: number;
  /** Populated by SynthesizerAgent only — structured signals next to the prose. */
  meta?: SynthesizerMeta;
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
}

export interface Blackboard {
  topic: string;
  turns: Turn[];
  conflicts: Conflict[];
  metadata: Record<string, unknown>;
}
