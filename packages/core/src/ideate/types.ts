/**
 * Ideate-mode types — Stage 3 (`add-ideate-mode`).
 *
 * `ideate` is a mode parallel to `deliberate`. It runs multiple frontier
 * models cooperatively (and optionally adversarially) over a single product
 * idea, persists the transcript to a dedicated `ideations` table, and
 * produces a single synthesized ideation document.
 *
 * Spec source: `openspec/changes/add-ideate-mode/specs/ideate-mode/spec.md`.
 */

/** Top-level sub-mode. Cooperative is the default. */
export type IdeateMode = 'cooperative' | 'adversarial' | 'full';

/** Contribution style. Collective (sequential) is the default. */
export type IdeateStyle = 'individual' | 'collective';

/**
 * The role a single agent plays in a sub-mode's lineup. The four cooperative
 * roles describe complementary postures the cooperative-build phase rotates
 * through; the two adversarial roles describe the critique-and-fix postures
 * exercised in `adversarial` and `full`.
 */
export type LineupRole =
  | 'proposer'
  | 'expander'
  | 'pragmatist'
  | 'lateralist'
  | 'skeptic'
  | 'devils-advocate';

/** A single role-to-model assignment within a resolved team. */
export interface LineupAssignment {
  role: LineupRole;
  /** OpenRouter-style model ID (e.g. `anthropic/claude-opus-4-6`). */
  model: string;
}

/** A resolved cooperative or adversarial team — ordered for stable transcripts. */
export interface LineupTeam {
  /** Cooperative team (proposer + expander + pragmatist + lateralist). */
  cooperative: readonly LineupAssignment[];
  /** Adversarial team (skeptic + devils-advocate). Empty for `cooperative` sub-mode. */
  adversarial: readonly LineupAssignment[];
}

/**
 * A fully-resolved lineup for a single ideate run. Produced by `resolveLineup`
 * from the in-code defaults + optional TOML overrides. Strict-by-default:
 * each TOML role override REPLACES the default for that role. There is no
 * field-level merging.
 */
export interface ResolvedLineup {
  mode: IdeateMode;
  /** Synthesizer model ID — sub-mode-specific (Opus 4.6 for cooperative/adversarial; Gemini 2.5 Pro for full). */
  synth: string;
  /** Cooperative + adversarial team assignments. */
  team: LineupTeam;
}

/**
 * The four ideate phases, in canonical execution order. Not every phase runs
 * for every sub-mode (cooperative skips adversarial + rebuttal; the rebuttal
 * phase may run 1 or 2 rounds in `adversarial`/`full`).
 */
export type IdeatePhaseId =
  | 'cooperative-build'
  | 'adversarial-critique'
  | 'rebuttal-1'
  | 'rebuttal-2'
  | 'synth';

/**
 * One agent contribution within a phase. Mirrors `Turn` in the deliberation
 * runtime but is intentionally separate so ideate's persistence schema can
 * evolve without coupling to deliberation's wire format.
 */
export interface PhaseContribution {
  role: LineupRole | 'synthesizer';
  model: string;
  content: string;
  /** Set on adversarial contributions when JSON parsing succeeded. */
  problems?: readonly Problem[];
  /**
   * Adversarial only — number of attempts the orchestrator made to extract
   * structured output (1 = clean, 2 = retried, undefined = phase doesn't apply).
   */
  attempts?: number;
  /** Adversarial only — true when both attempts failed and prose was preserved. */
  unstructured?: boolean;
  /** ISO 8601 timestamp the contribution was recorded. */
  timestamp: string;
}

/**
 * A structured problem-and-fix record produced by adversarial agents. The
 * adversarial phase prompt enforces this shape; the orchestrator parses the
 * agent's output once, retries once on failure, and falls back to preserving
 * raw prose on a second failure.
 */
export interface Problem {
  problem: string;
  proposed_fix: string;
}

/**
 * Outcome of one phase. The orchestrator emits one record per phase per run.
 * `phase` is the canonical ID; `style` echoes the run-level style only when
 * it affected the phase (cooperative-build cares; critique/synth do not).
 */
export interface PhaseRecord {
  phase: IdeatePhaseId;
  contributions: readonly PhaseContribution[];
  /** Set on `cooperative-build` only — `individual` | `collective`. */
  style?: IdeateStyle;
  /** Set on `synth` only — final synthesizer text. */
  synthesis?: string;
  /** Set when the phase emitted any structured warnings (e.g. unstructured adversarial output). */
  warnings?: readonly string[];
}

/**
 * Status of a persisted ideation row. `running` is set at insert time; the
 * orchestrator transitions to `complete` on success and `error` on
 * provider/parser failure mid-run.
 */
export type IdeationStatus = 'running' | 'complete' | 'error';

/**
 * One ideation run, persisted as a row in the `ideations` table. The DB
 * stores `lineup`, `phases`, and `synthesis` as JSON columns.
 */
export interface IdeationRecord {
  id: string;
  created_at: string;
  idea: string;
  mode: IdeateMode;
  style: IdeateStyle;
  status: IdeationStatus;
  lineup: ResolvedLineup;
  phases: readonly PhaseRecord[];
  synthesis: string | null;
  error: string | null;
  /** Optional Lattice coordination report when the run was launched with `--lattice`. */
  lattice?: LatticeReport | null;
}

/**
 * Lattice coordination metadata aggregated across all per-phase wrapped
 * model calls. Surfaced both on the `RunIdeationResult` and (eventually)
 * on the persisted `IdeationRecord` so consumers can ship audit reports
 * without re-running the deliberation.
 *
 * Phase-bucketed contracts let the synthesizer (and the human-facing
 * "Lattice Coordination Report") attribute conflicts and pass/fail outcomes
 * to the cooperative-build, adversarial-critique, or rebuttal step that
 * generated them.
 */
export interface LatticeReport {
  /** Whether the run was actually wrapped with Lattice (false = bypassed). */
  enabled: boolean;
  /** ULID-style trace ID of the cooperative-build phase (or first wrapped phase). */
  traceId: string;
  /** Aggregate ratio of models that agreed on the consensus fields. */
  agreementRatio: number;
  /** True when the agreement ratio met the configured `minAgreementRatio`. */
  consensusReached: boolean;
  /** Conflicts surfaced by ConsensusReducer across the cooperative team. */
  conflicts: ReadonlyArray<{
    field: string;
    values: ReadonlyArray<{ agentId: string; value: unknown }>;
    resolution: string;
  }>;
  /** Per-model pass/fail outcome for the cooperative + adversarial wrap. */
  modelOutcomes: ReadonlyArray<{
    agentId: string;
    role: string;
    isAdversarial: boolean;
    passed: boolean;
    breakerTier: 'L1' | 'L1+L2';
  }>;
  /** Path the audit log was written to (or `null` when no path was supplied). */
  auditLogPath: string | null;
}

/**
 * Caller-supplied Lattice options. When `enabled` is false, the orchestrator
 * runs unchanged. Default `shadowMode: true` ensures Circuit Breaker failures
 * NEVER abort a deliberation — they only surface in the report.
 */
export interface LatticeIdeateOptions {
  enabled: boolean;
  /** Path to the JSONL audit log. Defaults to `./parliament-audit.jsonl`. */
  auditLogPath?: string;
  /** ConsensusReducer minimum agreement ratio. Defaults to 0.6. */
  minAgreementRatio?: number;
  /**
   * Default to `true` — Lattice never blocks a Parliament deliberation. Set
   * to `false` only in tests that want to assert raw breaker behavior.
   */
  shadowMode?: boolean;
}

/**
 * Optional TOML override surface. Each role override REPLACES the default
 * for that role; missing entries fall back to in-code defaults. There is no
 * merge magic — see the spec's strict-by-default requirement.
 */
export interface IdeateLineupOverrides {
  cooperative?: Partial<Record<LineupRole, string>>;
  adversarial?: Partial<Record<LineupRole, string>>;
  full?: Partial<Record<LineupRole, string>>;
}

export interface IdeateSynthOverrides {
  cooperative?: string;
  adversarial?: string;
  full?: string;
}

export interface IdeateConfig {
  lineup?: IdeateLineupOverrides;
  synth?: IdeateSynthOverrides;
}
