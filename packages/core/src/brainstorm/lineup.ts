/**
 * Default brainstorm lineup + resolver. Distinct from ideate's lineup —
 * brainstorm needs divergent-author breadth plus judge independence, not
 * cooperative-team neurotypes plus adversaries.
 *
 * Spec: `add-brainstorm-mode/specs/brainstorm-mode/spec.md`.
 */

import type {
  BrainstormConfig,
  BrainstormLineup,
  BrainstormLineupAssignment,
} from './types.js';

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
 * the spec — each override list REPLACES the default for that role.
 *
 * Stub implementation: returns defaults unless overrides are present, in
 * which case it wholesale-replaces. Full validation (e.g., empty author
 * list rejection, model ID format check) lands in Section 3.
 */
export function resolveBrainstormLineup(config?: BrainstormConfig): BrainstormLineup {
  const base = defaultBrainstormLineup();
  const overrides = config?.lineup;
  if (overrides === undefined) return base;

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
