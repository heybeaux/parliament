/**
 * Brainstorm-mode types — first scaffolding for the `add-brainstorm-mode`
 * change. Distinct from `ideate-mode`; brainstorm is *divergent ideation +
 * ranking*, not single-idea refinement.
 *
 * Architectural lock: this module MUST NOT import from `../ideate/orchestrator`.
 * Reuse of `runDedupePhase` from `../ideate/dedupe.js` is intentional and
 * documented in the brainstorm orchestrator.
 *
 * Spec source: `openspec/changes/add-brainstorm-mode/specs/brainstorm-mode/spec.md`.
 */

/** Top-level brainstorm operation. `brainstorm/forge` is brainstorm + forge. */
export type BrainstormMode = 'brainstorm' | 'brainstorm/forge';

/** Locked criteria set for v1. Adding values requires a new spec change. */
export type BrainstormCriterion =
  | 'novelty'
  | 'feasibility'
  | 'fit'
  | 'evidence';

export const BRAINSTORM_CRITERIA: readonly BrainstormCriterion[] = [
  'novelty',
  'feasibility',
  'fit',
  'evidence',
];

/** Equal-weight defaults. Sum to 1.0. */
export const DEFAULT_RANK_WEIGHTS: Readonly<Record<BrainstormCriterion, number>> = {
  novelty: 0.25,
  feasibility: 0.25,
  fit: 0.25,
  evidence: 0.25,
};

/** A single divergent author or judge assignment. */
export interface BrainstormLineupAssignment {
  role: 'divergent-author' | 'judge' | 'cluster' | 'forge-elaborator';
  model: string;
}

export interface BrainstormLineup {
  divergentAuthors: readonly BrainstormLineupAssignment[];
  judges: readonly BrainstormLineupAssignment[];
  cluster: BrainstormLineupAssignment;
  forgeElaborator: BrainstormLineupAssignment;
}

/**
 * One generated idea from the divergent-generation phase. `author_model` is
 * load-bearing — the rank phase uses it to enforce author-aware judging.
 */
export interface BrainstormIdea {
  /** Stable hash of `(title, one_liner)` after dedupe. Set by orchestrator. */
  idea_id: string;
  title: string;
  one_liner: string;
  dimensions: readonly string[];
  rationale: string;
  /** Model ID of the divergent author that produced this idea. */
  author_model: string;
  /** Cluster label assigned by the cluster phase. `null` if cluster failed. */
  cluster?: string | null;
  /**
   * True when JSON parse + retry both failed. `rationale` contains the raw
   * model text. The idea is best-effort, not structured — consumers should
   * treat it as advisory and may omit it from ranking.
   */
  unstructured?: boolean;
}

/** Per-criterion score from a single judge. */
export interface CriterionScore {
  score: number;
  rationale: string;
}

/** One judge's full per-idea scoring. */
export interface JudgeScoring {
  judge_model: string;
  scores: Readonly<Record<BrainstormCriterion, CriterionScore>>;
}

/**
 * Final rank entry for one idea. `score: null` indicates all judges were
 * author-skipped for this idea (degenerate case). `judges_skipped` records
 * which judge model IDs were skipped due to author-aware skip.
 */
export interface BrainstormRanking {
  idea_id: string;
  score: number | null;
  per_criterion: Readonly<Record<BrainstormCriterion, number | null>>;
  judges_attempted: readonly string[];
  judges_skipped: readonly string[];
  judge_skipped: boolean;
}

/**
 * Enriched rank-phase output for one idea. Carries the full identity payload
 * (title, one_liner, dimensions, rationale, cluster) plus the final weighted
 * score, per-criterion averaged scores, judge attempt/skip bookkeeping, and
 * the descending rank position. `final_score` is `null` when every applicable
 * judge was author-skipped (both-judges-authored degenerate case); such
 * entries sort to the bottom by deterministic `idea_id` tiebreak.
 *
 * This is the canonical Section 7 output shape (see tasks.md 7.x). The legacy
 * `BrainstormRanking` shape above is preserved for callers that only want the
 * score + bookkeeping; orchestrator wiring (Section 9) decides which shape the
 * server response surfaces.
 */
export interface BrainstormRankedIdea {
  idea_id: string;
  title: string;
  one_liner: string;
  dimensions: readonly string[];
  rationale: string;
  cluster: string | null;
  /** Weighted sum across criteria of averaged judge scores. */
  final_score: number | null;
  criteria_scores: Readonly<Record<BrainstormCriterion, number | null>>;
  judges_attempted: readonly string[];
  judges_skipped: readonly string[];
  /** 1-based descending rank position; null when final_score is null. */
  rank: number | null;
  /** True when every applicable judge was author-skipped for this idea. */
  judge_skipped: boolean;
}

/** Elaboration of one top-K idea (forge phase only). */
export interface ForgeElaboration {
  idea_id: string;
  elaboration: string | null;
  model: string;
  timestamp: string;
  /** Set when this elaboration failed; `elaboration` is `null` in that case. */
  error?: string;
}

export type BrainstormPhaseId =
  | 'divergent-generation'
  | 'idea-dedupe'
  | 'idea-cluster'
  | 'idea-rank'
  | 'forge-elaboration';

export interface BrainstormPhaseRecord {
  phase: BrainstormPhaseId;
  /**
   * Ideas surviving this phase. For `divergent-generation` this is the
   * union across authors; for `idea-dedupe` this is the dedupe survivors;
   * for `idea-cluster` it's the same set with `cluster` populated; for
   * `idea-rank` it's unchanged (rank output lives in `RunBrainstormResult.rankings`).
   */
  ideas?: readonly BrainstormIdea[];
  /** Dedupe phase only — same shape as ideate's dedupe record. */
  dedupe?: {
    kept: readonly string[];
    merged_into: Record<string, string>;
    threshold: number;
    provider: 'local' | 'cloud' | null;
    skipped: boolean;
  };
  /** Cluster phase only — label-to-idea-IDs map. */
  cluster_map?: Readonly<Record<string, readonly string[]>>;
  /** Per-judge scoring rolled up for the rank phase. */
  judgings?: readonly JudgeScoring[];
  /**
   * Rank phase only — fully-enriched ranked ideas in descending final_score
   * order (with `null` scores sorted to the end, broken by `idea_id` for
   * determinism).
   */
  ranked?: readonly BrainstormRankedIdea[];
  /** Forge phase only. */
  elaborations?: readonly ForgeElaboration[];
  warnings?: readonly string[];
}

export type BrainstormStatus = 'running' | 'complete' | 'error';

export interface RunBrainstormInput {
  prompt: string;
  mode: BrainstormMode;
  lineup: BrainstormLineup;
  /** Default 5. */
  ideasPerAuthor?: number;
  /** Default 3. Only consulted when mode === 'brainstorm/forge'. */
  forgeK?: number;
  /** Weights per criterion. Default `DEFAULT_RANK_WEIGHTS`. Must sum to ~1.0. */
  weights?: Readonly<Record<BrainstormCriterion, number>>;
}

export interface RunBrainstormResult {
  status: BrainstormStatus;
  phases: readonly BrainstormPhaseRecord[];
  /** Ranked list, descending by final score. `null` scores sort to the end. */
  rankings: readonly BrainstormRanking[];
  /** Present only when mode === 'brainstorm/forge'. */
  elaborations?: readonly ForgeElaboration[] | null;
  error: string | null;
}

/** TOML override surface. */
export interface BrainstormLineupOverrides {
  divergentAuthors?: readonly string[];
  judges?: readonly string[];
  cluster?: string;
  forgeElaborator?: string;
}

export interface BrainstormRankWeights {
  novelty?: number;
  feasibility?: number;
  fit?: number;
  evidence?: number;
}

export interface BrainstormConfig {
  lineup?: BrainstormLineupOverrides;
  rank?: {
    weights?: BrainstormRankWeights;
  };
  ideas_per_author?: number;
  forge?: {
    k?: number;
  };
}
