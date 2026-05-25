/**
 * Brainstorm-mode public exports. Mirrors `../ideate/index` shape.
 *
 * Spec: `openspec/changes/add-brainstorm-mode/`.
 */

export type {
  BrainstormMode,
  BrainstormCriterion,
  BrainstormLineup,
  BrainstormLineupAssignment,
  BrainstormIdea,
  CriterionScore,
  JudgeScoring,
  BrainstormRanking,
  BrainstormRankedIdea,
  ForgeElaboration,
  BrainstormPhaseId,
  BrainstormPhaseRecord,
  BrainstormStatus,
  RunBrainstormInput,
  RunBrainstormResult,
  BrainstormConfig,
  BrainstormLineupOverrides,
  BrainstormRankWeights,
} from './types.js';

export {
  BRAINSTORM_CRITERIA,
  DEFAULT_RANK_WEIGHTS,
} from './types.js';

export {
  defaultBrainstormLineup,
  resolveBrainstormLineup,
  resolveRankWeights,
} from './lineup.js';

export { runBrainstorm } from './orchestrator.js';
export type { AdapterFactory, RunBrainstormOptions } from './orchestrator.js';

export { runIdeaDedupePhase, stableIdeaId } from './dedupe.js';
export type { RunIdeaDedupeInput, IdeaDedupeOutput } from './dedupe.js';

export { runClusterPhase } from './cluster.js';
export type { RunClusterPhaseInput, ClusterPhaseOutput } from './cluster.js';

export { runRankPhase } from './rank.js';
export type { RunRankPhaseInput, RankPhaseOutput } from './rank.js';

export { runDivergentGeneration } from './divergent.js';
export type {
  RunDivergentGenerationInput,
  DivergentGenerationOutput,
} from './divergent.js';

export { elaborateIdea, forgeTopK } from './forge.js';
