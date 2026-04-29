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
