/**
 * Rank phase for brainstorm mode (Section 7).
 *
 * Each judge in the lineup independently scores every surviving idea on the
 * four locked criteria (novelty / feasibility / fit / evidence, integer 0–10
 * each). Judges run in parallel — no anchoring, no cross-judge visibility.
 *
 * Author-aware skip (task 7.3): a judge whose model ID matches an idea's
 * `author_model` is skipped for THAT idea (the orchestrator filters its score
 * out before averaging). When BOTH judges authored an idea (the degenerate
 * "both-judges-authored" case from design.md), the idea surfaces with
 * `final_score: null`, `judge_skipped: true`, `judges_attempted: []`,
 * `judges_skipped: [<every judge>]`. These ideas sort to the bottom; among
 * themselves they are ordered by `idea_id` for determinism.
 *
 * Failure model (design choice): if a single judge fails after one-shot retry,
 * that judge is treated as skipped for ALL ideas — we don't try to partially
 * recover a corrupt judge response per-idea. Rationale: a judge that fails
 * parse twice is unreliable; mixing partial scores with full scores would
 * bias averages unpredictably. The other judge's scores still produce a
 * usable ranking (or `null` when the other judge also failed / authored).
 *
 * Unstructured ideas (per `BrainstormIdea.unstructured`): included in the
 * prompt with empty title/one_liner — judges decide whether to score them.
 * In practice, judges typically score these very low on fit/evidence (no
 * concrete proposition to evaluate). This is documented behaviour, not a
 * hard rule; if it becomes a problem we can filter them out of the prompt
 * in a follow-up.
 *
 * Final score = weighted sum across criteria of averaged judge scores
 * (averaged over non-skipped judges per-criterion). Weights come from
 * `resolveRankWeights` (already normalized to sum=1.0). Ranking is descending
 * by final_score; ties broken by `idea_id` lex order for determinism.
 *
 * Spec: `openspec/changes/add-brainstorm-mode/tasks.md` Section 7.
 */

import type { ModelAdapter } from '../adapters/base.js';
import type { AdapterFactory } from './orchestrator.js';
import {
  BRAINSTORM_CRITERIA,
  type BrainstormCriterion,
  type BrainstormIdea,
  type BrainstormLineup,
  type BrainstormPhaseRecord,
  type BrainstormRankedIdea,
  type CriterionScore,
  type JudgeScoring,
} from './types.js';
import { rankPrompt, RANK_RETRY_INSTRUCTION } from './prompts.js';

export interface RunRankPhaseInput {
  prompt: string;
  /** Post-cluster surviving ideas. Each carries its `author_model`. */
  ideas: readonly BrainstormIdea[];
  /** Full lineup — only `judges` is consulted here. */
  lineup: BrainstormLineup;
  /** Normalized weights (sum to 1.0). From `resolveRankWeights`. */
  weights: Readonly<Record<BrainstormCriterion, number>>;
  /** Cluster label → idea_ids, advisory context for the judge prompt. */
  clusterMap?: Readonly<Record<string, readonly string[]>>;
  factory: AdapterFactory;
}

export interface RankPhaseOutput {
  /** Ranked ideas in descending final_score order (nulls last, idea_id tiebreak). */
  ranked: BrainstormRankedIdea[];
  warnings: string[];
  phaseRecord: BrainstormPhaseRecord;
}

interface RawScore {
  idea_id?: unknown;
  novelty?: unknown;
  feasibility?: unknown;
  fit?: unknown;
  evidence?: unknown;
  rationale?: unknown;
}

// ---------------------------------------------------------------------------
// JSON parsing (mirrors divergent.ts / cluster.ts patterns)
// ---------------------------------------------------------------------------

function tryParseScores(raw: string): RawScore[] | null {
  const strict = tryParse(raw.trim());
  if (strict !== null) return strict;

  const fence = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fence !== null && typeof fence[1] === 'string') {
    const fenced = tryParse(fence[1].trim());
    if (fenced !== null) return fenced;
  }

  const firstOpen = raw.indexOf('{');
  if (firstOpen === -1) return null;
  let depth = 0;
  for (let i = firstOpen; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const candidate = raw.slice(firstOpen, i + 1);
        const balanced = tryParse(candidate);
        if (balanced !== null) return balanced;
      }
    }
  }
  return null;
}

function tryParse(text: string): RawScore[] | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;
    if (!Array.isArray(obj['scores'])) return null;
    return obj['scores'] as RawScore[];
  } catch {
    return null;
  }
}

function clampScore(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 10) return 10;
  return n;
}

/**
 * Validate raw scores and project them onto the expected idea_id set.
 * Returns `null` if structurally invalid. A response is invalid if:
 *   - any entry lacks a string `idea_id`
 *   - any entry references an unknown idea_id
 *   - any expected idea_id is missing
 *   - any idea_id appears more than once
 *   - any criterion is missing or non-numeric (after coercion)
 *
 * Per-idea `rationale` is optional — judges sometimes omit it; we default to
 * empty string rather than rejecting.
 */
function shapeJudgeScoring(
  raw: RawScore[],
  judgeModel: string,
  expectedIds: readonly string[],
): JudgeScoring[] | null {
  const expectedSet = new Set(expectedIds);
  const seen = new Set<string>();
  const perIdea = new Map<string, Record<BrainstormCriterion, CriterionScore>>();

  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) return null;
    const ideaId = entry.idea_id;
    if (typeof ideaId !== 'string' || ideaId.trim() === '') return null;
    if (!expectedSet.has(ideaId)) return null;
    if (seen.has(ideaId)) return null;
    seen.add(ideaId);

    const rationaleRaw = entry.rationale;
    const rationale = typeof rationaleRaw === 'string' ? rationaleRaw.trim() : '';

    const scores: Partial<Record<BrainstormCriterion, CriterionScore>> = {};
    for (const c of BRAINSTORM_CRITERIA) {
      const v = entry[c];
      if (typeof v !== 'number' || !Number.isFinite(v)) return null;
      scores[c] = { score: clampScore(v), rationale };
    }
    perIdea.set(ideaId, scores as Record<BrainstormCriterion, CriterionScore>);
  }

  for (const id of expectedIds) {
    if (!seen.has(id)) return null;
  }

  // Flatten into per-idea JudgeScoring records. We keep one JudgeScoring per
  // (judge, idea) so the phase record is granular enough for the orchestrator
  // to inspect later without recomputing.
  const out: JudgeScoring[] = [];
  for (const id of expectedIds) {
    const scores = perIdea.get(id)!;
    out.push({ judge_model: `${judgeModel}#${id}`, scores });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-judge invocation
// ---------------------------------------------------------------------------

interface JudgeResult {
  judgeModel: string;
  /**
   * idea_id → per-criterion score. Empty when the judge failed after retry
   * (the judge is treated as skipped for every idea).
   */
  perIdea: Map<string, Record<BrainstormCriterion, CriterionScore>>;
  /** True when the judge failed entirely (parse fail after retry, or throw). */
  failed: boolean;
  warning?: string;
}

async function invokeJudge(
  judgeModel: string,
  prompt: string,
  ideas: readonly BrainstormIdea[],
  clusterMap: Readonly<Record<string, readonly string[]>> | undefined,
  factory: AdapterFactory,
): Promise<JudgeResult> {
  const expectedIds = ideas.map((i) => i.idea_id);
  const { system, user } = rankPrompt({
    prompt,
    ideas: ideas.map((i) => ({
      idea_id: i.idea_id,
      title: i.title,
      one_liner: i.one_liner,
      dimensions: i.dimensions,
      rationale: i.rationale,
      cluster: i.cluster ?? null,
    })),
    clusterMap,
    judgeModel,
  });

  let adapter: ModelAdapter;
  try {
    adapter = factory(judgeModel);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      judgeModel,
      perIdea: new Map(),
      failed: true,
      warning: `idea-rank: judge ${judgeModel} factory failed (${msg}); treating judge as skipped.`,
    };
  }

  let firstContent = '';
  let raw: RawScore[] | null = null;
  try {
    const first = await adapter.generate(user, system);
    firstContent = first.content;
    raw = tryParseScores(first.content);

    if (raw === null) {
      const retry = await adapter.generate(
        `${RANK_RETRY_INSTRUCTION}\n\nOriginal prompt:\n${user}\n\nYour previous response:\n${first.content}`,
        system,
      );
      raw = tryParseScores(retry.content);
      if (raw === null) {
        return {
          judgeModel,
          perIdea: new Map(),
          failed: true,
          warning: `idea-rank: judge ${judgeModel} returned unparseable JSON after retry; treating judge as skipped for all ideas.`,
        };
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      judgeModel,
      perIdea: new Map(),
      failed: true,
      warning: `idea-rank: judge ${judgeModel} call failed (${msg}); treating judge as skipped for all ideas.`,
    };
  }

  const shaped = shapeJudgeScoring(raw, judgeModel, expectedIds);
  if (shaped === null) {
    return {
      judgeModel,
      perIdea: new Map(),
      failed: true,
      warning: `idea-rank: judge ${judgeModel} returned structurally invalid scores (missing/unknown/duplicate idea_ids or non-numeric criteria); treating judge as skipped. raw=${firstContent.slice(0, 200)}`,
    };
  }

  const perIdea = new Map<string, Record<BrainstormCriterion, CriterionScore>>();
  for (const entry of shaped) {
    // shapeJudgeScoring emits judge_model = `${judgeModel}#${ideaId}`; recover ideaId.
    const hashIdx = entry.judge_model.lastIndexOf('#');
    const ideaId = hashIdx === -1 ? entry.judge_model : entry.judge_model.slice(hashIdx + 1);
    perIdea.set(ideaId, entry.scores);
  }

  return { judgeModel, perIdea, failed: false };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

interface IdeaAggregate {
  perCriterion: Record<BrainstormCriterion, number | null>;
  judgesAttempted: string[];
  judgesSkipped: string[];
  finalScore: number | null;
  judgeSkipped: boolean;
}

function aggregateIdea(
  idea: BrainstormIdea,
  allJudges: readonly string[],
  judgeResults: readonly JudgeResult[],
  weights: Readonly<Record<BrainstormCriterion, number>>,
): IdeaAggregate {
  const attempted: string[] = [];
  const skipped: string[] = [];
  // criterion → list of scores from non-skipped judges
  const collected: Record<BrainstormCriterion, number[]> = {
    novelty: [],
    feasibility: [],
    fit: [],
    evidence: [],
  };

  for (const judge of allJudges) {
    // Author-aware skip — judge model ID matches idea's author.
    if (judge === idea.author_model) {
      skipped.push(judge);
      continue;
    }
    const result = judgeResults.find((r) => r.judgeModel === judge);
    if (result === undefined || result.failed) {
      // Whole-judge failure counts as skipped for every idea, NOT as author-skip.
      skipped.push(judge);
      continue;
    }
    const scores = result.perIdea.get(idea.idea_id);
    if (scores === undefined) {
      // Should not happen (shapeJudgeScoring guarantees full coverage), but
      // defensive: treat as skipped.
      skipped.push(judge);
      continue;
    }
    attempted.push(judge);
    for (const c of BRAINSTORM_CRITERIA) {
      collected[c].push(scores[c].score);
    }
  }

  if (attempted.length === 0) {
    // All judges skipped (author-skipped or judge-failed). final_score=null.
    return {
      perCriterion: { novelty: null, feasibility: null, fit: null, evidence: null },
      judgesAttempted: attempted,
      judgesSkipped: skipped,
      finalScore: null,
      judgeSkipped: true,
    };
  }

  const perCriterion: Record<BrainstormCriterion, number | null> = {
    novelty: null,
    feasibility: null,
    fit: null,
    evidence: null,
  };
  let final = 0;
  for (const c of BRAINSTORM_CRITERIA) {
    const arr = collected[c];
    const avg = arr.reduce((s, n) => s + n, 0) / arr.length;
    perCriterion[c] = avg;
    final += avg * weights[c];
  }

  return {
    perCriterion,
    judgesAttempted: attempted,
    judgesSkipped: skipped,
    finalScore: final,
    judgeSkipped: false,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runRankPhase({
  prompt,
  ideas,
  lineup,
  weights,
  clusterMap,
  factory,
}: RunRankPhaseInput): Promise<RankPhaseOutput> {
  // Empty input — nothing to rank.
  if (ideas.length === 0) {
    return {
      ranked: [],
      warnings: [],
      phaseRecord: {
        phase: 'idea-rank',
        ideas: [],
        ranked: [],
        judgings: [],
      },
    };
  }

  const judgeModels = lineup.judges.map((j) => j.model);

  // If no judges are configured, every idea collapses to score=null. This is a
  // degenerate configuration but we don't throw — the empty-judges case is
  // structurally identical to "all judges skipped".
  const judgeResults: JudgeResult[] = await Promise.all(
    judgeModels.map((m) => invokeJudge(m, prompt, ideas, clusterMap, factory)),
  );

  const warnings: string[] = [];
  for (const r of judgeResults) {
    if (r.warning !== undefined) warnings.push(r.warning);
  }

  // Aggregate per-idea.
  const aggregates = new Map<string, IdeaAggregate>();
  for (const idea of ideas) {
    aggregates.set(idea.idea_id, aggregateIdea(idea, judgeModels, judgeResults, weights));
  }

  // Build ranked array. Sort descending by final_score; nulls sort last.
  // Ties (including ties between nulls) are broken by idea_id lex ascending
  // for cross-run determinism.
  const enriched: BrainstormRankedIdea[] = ideas.map((idea) => {
    const agg = aggregates.get(idea.idea_id)!;
    return {
      idea_id: idea.idea_id,
      title: idea.title,
      one_liner: idea.one_liner,
      dimensions: idea.dimensions,
      rationale: idea.rationale,
      cluster: idea.cluster ?? null,
      final_score: agg.finalScore,
      criteria_scores: agg.perCriterion,
      judges_attempted: agg.judgesAttempted,
      judges_skipped: agg.judgesSkipped,
      rank: null, // assigned post-sort
      judge_skipped: agg.judgeSkipped,
    };
  });

  enriched.sort((a, b) => {
    const aNull = a.final_score === null;
    const bNull = b.final_score === null;
    if (aNull && !bNull) return 1;
    if (bNull && !aNull) return -1;
    if (!aNull && !bNull && a.final_score !== b.final_score) {
      return (b.final_score as number) - (a.final_score as number);
    }
    // Deterministic tiebreak.
    return a.idea_id < b.idea_id ? -1 : a.idea_id > b.idea_id ? 1 : 0;
  });

  // Assign 1-based rank to scored ideas. `null`-score ideas get `rank: null`.
  let nextRank = 1;
  for (const r of enriched) {
    if (r.final_score === null) {
      r.rank = null;
    } else {
      r.rank = nextRank++;
    }
  }

  // Per-judge rolled-up scoring for the phase record. One JudgeScoring per
  // (judge, idea) — granular enough for downstream tooling.
  const judgings: JudgeScoring[] = [];
  for (const result of judgeResults) {
    if (result.failed) continue;
    for (const [ideaId, scores] of result.perIdea.entries()) {
      judgings.push({ judge_model: `${result.judgeModel}#${ideaId}`, scores });
    }
  }

  const phaseRecord: BrainstormPhaseRecord = {
    phase: 'idea-rank',
    ideas,
    ranked: enriched,
    judgings,
    warnings: warnings.length > 0 ? warnings : undefined,
  };

  return { ranked: enriched, warnings, phaseRecord };
}
