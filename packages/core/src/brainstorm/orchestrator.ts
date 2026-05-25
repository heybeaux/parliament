/**
 * Brainstorm orchestrator — entry point for the brainstorm reasoning
 * pattern. Pipeline:
 *
 *   divergent-generation → idea-dedupe → idea-cluster → idea-rank
 *                                                       → [forge-elaboration]
 *
 * Spec: `openspec/changes/add-brainstorm-mode/specs/brainstorm-mode/spec.md`.
 *
 * ARCHITECTURAL LOCK: this orchestrator MUST NOT import `runIdeation` from
 * `../ideate/orchestrator`. Brainstorm is a distinct runtime — aliasing the
 * routes over ideate is the bug this change exists to fix (see
 * `docs/2026-05-23-rook-handover-brainstorm-forge-training-pattern.md`).
 *
 * Intentional reuse: `runDedupePhase` from `../ideate/dedupe.js` is shared
 * because cosine-collapse on candidate text is a general primitive, not an
 * ideate-specific behavior. The brainstorm dedupe phase is recorded as
 * `phase: 'idea-dedupe'` so transcripts remain distinguishable.
 *
 * Section-9 wiring: the orchestrator drives the phases serially, threading
 * the BrainstormPhaseRecord array via an optional `onPhase` callback so the
 * server's background runner can persist phases as they complete (matches
 * the spec's fire-and-forget contract).
 */

import type { ModelAdapter } from '../adapters/base.js';
// Intentional cross-module reuse: runDedupePhase is a general-purpose cosine-
// collapse primitive that lives under ideate/ because it shipped there first.
// Brainstorm's idea-dedupe phase reuses it unchanged via
// `brainstorm/dedupe.ts`. This re-export here makes the reuse explicit at the
// orchestrator level so the architectural lock test
// (__tests__/no-ideate-coupling.test.ts, task 12.2) can confirm it.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { runDedupePhase as _runDedupePhase } from '../ideate/dedupe.js';
import { runDivergentGeneration } from './divergent.js';
import { runIdeaDedupePhase } from './dedupe.js';
import { runClusterPhase } from './cluster.js';
import { runRankPhase } from './rank.js';
import { forgeTopK } from './forge.js';
import { resolveRankWeights } from './lineup.js';
import { DEFAULT_RANK_WEIGHTS } from './types.js';
import type {
  BrainstormPhaseRecord,
  BrainstormRankedIdea,
  BrainstormRanking,
  RunBrainstormInput,
  RunBrainstormResult,
} from './types.js';

export type AdapterFactory = (model: string) => ModelAdapter;

const DEFAULT_IDEAS_PER_AUTHOR = 5;
const DEFAULT_FORGE_K = 3;

export interface RunBrainstormOptions {
  /**
   * Invoked once per phase as it completes, in pipeline order. The callback
   * receives the cumulative phases array; servers should persist a snapshot
   * of it (e.g. JSON-stringify into the `brainstorms.phases` column) so a
   * polling client sees progressive state.
   */
  onPhase?: (phases: readonly BrainstormPhaseRecord[]) => void;
}

function projectRankings(
  ranked: readonly BrainstormRankedIdea[],
): BrainstormRanking[] {
  return ranked.map((r) => ({
    idea_id: r.idea_id,
    score: r.final_score,
    per_criterion: r.criteria_scores,
    judges_attempted: r.judges_attempted,
    judges_skipped: r.judges_skipped,
    judge_skipped: r.judge_skipped,
  }));
}

/**
 * Entry point for one brainstorm run. Returns a fully-populated result
 * including partial `phases` when an error aborts mid-run, mirroring
 * `runIdeation`'s contract for server persistence.
 */
export async function runBrainstorm(
  input: RunBrainstormInput,
  factory: AdapterFactory,
  options: RunBrainstormOptions = {},
): Promise<RunBrainstormResult> {
  const ideasPerAuthor = input.ideasPerAuthor ?? DEFAULT_IDEAS_PER_AUTHOR;
  const forgeK = input.forgeK ?? DEFAULT_FORGE_K;
  // Section 11 (TOML) hasn't landed yet; for now resolveRankWeights handles
  // the per-run override + normalization against DEFAULT_RANK_WEIGHTS.
  const weights = input.weights
    ? resolveRankWeights({ rank: { weights: input.weights } })
    : DEFAULT_RANK_WEIGHTS;

  const phases: BrainstormPhaseRecord[] = [];
  const emit = (record: BrainstormPhaseRecord): void => {
    phases.push(record);
    options.onPhase?.(phases);
  };

  try {
    // ---- divergent-generation ----
    const divergent = await runDivergentGeneration({
      prompt: input.prompt,
      lineup: input.lineup,
      ideasPerAuthor,
      factory,
    });
    emit(divergent.phaseRecord);

    // Structured-only ideas continue downstream; unstructured ideas are
    // preserved on the phase record but excluded from dedupe/rank per spec.
    const structured = divergent.ideas.filter((i) => i.unstructured !== true);

    // ---- idea-dedupe ----
    const dedupe = await runIdeaDedupePhase({ ideas: structured });
    emit(dedupe.phaseRecord);

    // ---- idea-cluster ----
    const cluster = await runClusterPhase({
      prompt: input.prompt,
      ideas: dedupe.ideas,
      clusterModel: input.lineup.cluster.model,
      factory,
    });
    emit(cluster.phaseRecord);

    // ---- idea-rank ----
    const rank = await runRankPhase({
      prompt: input.prompt,
      ideas: cluster.ideas,
      lineup: input.lineup,
      weights,
      clusterMap: cluster.phaseRecord.cluster_map,
      factory,
    });
    emit(rank.phaseRecord);

    let elaborations: RunBrainstormResult['elaborations'] = null;

    // ---- forge-elaboration (opt-in) ----
    if (input.mode === 'brainstorm/forge') {
      const forgeElaborations = await forgeTopK(
        rank.ranked,
        input.prompt,
        forgeK,
        input.lineup.forgeElaborator.model,
        factory,
      );
      const forgeRecord: BrainstormPhaseRecord = {
        phase: 'forge-elaboration',
        elaborations: forgeElaborations,
      };
      emit(forgeRecord);
      elaborations = forgeElaborations;
    }

    return {
      status: 'complete',
      phases,
      rankings: projectRankings(rank.ranked),
      elaborations: input.mode === 'brainstorm/forge' ? elaborations : null,
      error: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: 'error',
      phases,
      rankings: [],
      elaborations: input.mode === 'brainstorm/forge' ? [] : null,
      error: message,
    };
  }
}
