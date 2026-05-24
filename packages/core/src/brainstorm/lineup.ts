/**
 * Default brainstorm lineup + resolver. Distinct from ideate's lineup —
 * brainstorm needs divergent-author breadth plus judge independence, not
 * cooperative-team neurotypes plus adversaries.
 *
 * Spec: `add-brainstorm-mode/specs/brainstorm-mode/spec.md`.
 */

import type {
  BrainstormConfig,
  BrainstormCriterion,
  BrainstormLineup,
  BrainstormLineupAssignment,
  BrainstormRankWeights,
} from './types.js';
import { BRAINSTORM_CRITERIA, DEFAULT_RANK_WEIGHTS } from './types.js';

// Reuse the closed/open model constants from ideate to stay model-pinning
// consistent across the repo. Brainstorm picks a different subset.
import { CLOSED_MODELS, OPEN_MODELS } from '../ideate/lineup.js';

/**
 * Default divergent-author pool — 4 models chosen for breadth and
 * willingness to propose unconventional ideas.
 */
const DEFAULT_DIVERGENT_AUTHORS: readonly BrainstormLineupAssignment[] = [
  { role: 'divergent-author', model: CLOSED_MODELS.opus },
  { role: 'divergent-author', model: CLOSED_MODELS.gemini },
  { role: 'divergent-author', model: CLOSED_MODELS.gpt5 },
  { role: 'divergent-author', model: OPEN_MODELS.deepseek },
];

/**
 * Default judges — 2 models for second-opinion scoring. GPT-5 overlaps the
 * divergent-author pool; the rank phase enforces author-aware skip so a
 * judge never scores its own ideas.
 */
const DEFAULT_JUDGES: readonly BrainstormLineupAssignment[] = [
  { role: 'judge', model: CLOSED_MODELS.sonnet },
  { role: 'judge', model: CLOSED_MODELS.gpt5 },
];

const DEFAULT_CLUSTER: BrainstormLineupAssignment = {
  role: 'cluster',
  model: CLOSED_MODELS.opus,
};

const DEFAULT_FORGE_ELABORATOR: BrainstormLineupAssignment = {
  role: 'forge-elaborator',
  model: CLOSED_MODELS.opus,
};

export function defaultBrainstormLineup(): BrainstormLineup {
  return {
    divergentAuthors: DEFAULT_DIVERGENT_AUTHORS,
    judges: DEFAULT_JUDGES,
    cluster: DEFAULT_CLUSTER,
    forgeElaborator: DEFAULT_FORGE_ELABORATOR,
  };
}

/**
 * Resolves defaults against optional TOML overrides. Strict-by-default per
 * the spec — each override list REPLACES the default for that role. Empty
 * arrays are rejected (likely user error, and silently running with zero
 * authors or zero judges would produce empty rankings with no clear cause).
 * Non-string model IDs and whitespace-only model IDs are rejected too.
 */
export function resolveBrainstormLineup(config?: BrainstormConfig): BrainstormLineup {
  const base = defaultBrainstormLineup();
  const overrides = config?.lineup;
  if (overrides === undefined) return base;

  if (overrides.divergentAuthors !== undefined) {
    validateModelList('divergentAuthors', overrides.divergentAuthors);
  }
  if (overrides.judges !== undefined) {
    validateModelList('judges', overrides.judges);
  }
  if (overrides.cluster !== undefined) {
    validateModelId('cluster', overrides.cluster);
  }
  if (overrides.forgeElaborator !== undefined) {
    validateModelId('forgeElaborator', overrides.forgeElaborator);
  }

  return {
    divergentAuthors:
      overrides.divergentAuthors !== undefined
        ? overrides.divergentAuthors.map((model) => ({
            role: 'divergent-author' as const,
            model,
          }))
        : base.divergentAuthors,
    judges:
      overrides.judges !== undefined
        ? overrides.judges.map((model) => ({ role: 'judge' as const, model }))
        : base.judges,
    cluster:
      overrides.cluster !== undefined
        ? { role: 'cluster', model: overrides.cluster }
        : base.cluster,
    forgeElaborator:
      overrides.forgeElaborator !== undefined
        ? { role: 'forge-elaborator', model: overrides.forgeElaborator }
        : base.forgeElaborator,
  };
}

function validateModelList(key: string, list: readonly string[]): void {
  if (list.length === 0) {
    throw new Error(
      `Parliament: [brainstorm.lineup.${key}] override is empty. ` +
        `Provide at least one model ID, or remove the override to use defaults.`,
    );
  }
  for (let i = 0; i < list.length; i++) {
    validateModelId(`${key}[${i}]`, list[i]);
  }
}

function validateModelId(label: string, model: unknown): void {
  if (typeof model !== 'string' || model.trim() === '') {
    throw new Error(
      `Parliament: [brainstorm.lineup.${label}] must be a non-empty string model ID, got ${JSON.stringify(model)}.`,
    );
  }
}

/**
 * Resolves rank weights from TOML + request-body overrides into a fully
 * normalized record summing to 1.0.
 *
 * Resolution order (per design.md "Resolved Decisions"):
 *   1. Start from DEFAULT_RANK_WEIGHTS (0.25 each).
 *   2. Apply TOML `[brainstorm.rank.weights]` as partial-replace.
 *   3. Apply per-run override (e.g. request-body `rank_weights`) as
 *      partial-replace on top of that.
 *   4. Normalize so the sum is 1.0.
 *
 * Invariants:
 *   - Each criterion is finite and >= 0.
 *   - At least one criterion is > 0 (otherwise normalization would divide
 *     by zero and the rank phase would have no signal).
 *
 * Throws on negative, NaN, or all-zero weights. Negative weights are
 * almost always a user mistake (you can't subtract value from an idea),
 * and we'd rather fail loudly than silently flip a sign during normalize.
 */
export function resolveRankWeights(
  config?: BrainstormConfig,
  override?: BrainstormRankWeights,
): Record<BrainstormCriterion, number> {
  const merged: Record<BrainstormCriterion, number> = { ...DEFAULT_RANK_WEIGHTS };

  const tomlWeights = config?.rank?.weights;
  if (tomlWeights !== undefined) {
    applyWeightOverrides(merged, tomlWeights, '[brainstorm.rank.weights]');
  }
  if (override !== undefined) {
    applyWeightOverrides(merged, override, 'request rank_weights');
  }

  const sum = BRAINSTORM_CRITERIA.reduce((acc, k) => acc + merged[k], 0);
  if (sum <= 0) {
    throw new Error(
      `Parliament: brainstorm rank weights must include at least one positive value; got all zeros.`,
    );
  }

  const normalized: Record<BrainstormCriterion, number> = {
    novelty: 0,
    feasibility: 0,
    fit: 0,
    evidence: 0,
  };
  for (const k of BRAINSTORM_CRITERIA) {
    normalized[k] = merged[k] / sum;
  }
  return normalized;
}

function applyWeightOverrides(
  target: Record<BrainstormCriterion, number>,
  overrides: BrainstormRankWeights,
  source: string,
): void {
  for (const k of BRAINSTORM_CRITERIA) {
    const v = overrides[k];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      throw new Error(
        `Parliament: ${source} weight for "${k}" must be a finite non-negative number, got ${JSON.stringify(v)}.`,
      );
    }
    target[k] = v;
  }
}
