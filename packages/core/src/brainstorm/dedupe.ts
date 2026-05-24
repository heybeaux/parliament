/**
 * Idea-dedupe phase for brainstorm mode.
 *
 * Adapts `BrainstormIdea[]` to the `PhaseContribution` interface required by
 * `runDedupePhase`, runs cosine-collapse on the idea text, then maps survivors
 * back to `BrainstormIdea` with final stable `idea_id` assignments.
 *
 * `idea_id` ownership: divergent.ts sets a temp local ID (`${model}#${idx}_${i}`).
 * This phase is the first moment all ideas are visible together, so it owns
 * final ID assignment — a stable hash of `(title, one_liner)` per the locked
 * design decision in `openspec/changes/add-brainstorm-mode/design.md`.
 *
 * Spec: `openspec/changes/add-brainstorm-mode/tasks.md` Section 5.
 */

import { createHash } from 'node:crypto';
import { runDedupePhase } from '../ideate/dedupe.js';
import type { DedupeOptions } from '../ideate/dedupe.js';
import type { PhaseContribution } from '../ideate/types.js';
import type { BrainstormIdea, BrainstormPhaseRecord } from './types.js';

export interface RunIdeaDedupeInput {
  ideas: readonly BrainstormIdea[];
  opts?: DedupeOptions;
}

export interface IdeaDedupeOutput {
  ideas: BrainstormIdea[];
  warnings: string[];
  phaseRecord: BrainstormPhaseRecord;
}

/**
 * Stable idea_id: SHA-256 of `${title}\0${one_liner}`, first 16 hex chars.
 * Collision risk is negligible within a single run and acceptable across runs
 * (per design.md "Identity preservation" decision). Unstructured ideas use
 * their temp ID unchanged — no title/one_liner to hash.
 */
export function stableIdeaId(title: string, oneLiner: string): string {
  return createHash('sha256')
    .update(`${title}\0${oneLiner}`)
    .digest('hex')
    .slice(0, 16);
}

/**
 * Produce the text content used for embedding. For structured ideas this is
 * `title: <title>\none_liner: <one_liner>` — a compact, stable representation
 * that captures the semantic identity of the idea without rationale noise.
 * For unstructured ideas (no title/one_liner) we fall back to `rationale`.
 */
function ideaEmbedText(idea: BrainstormIdea): string {
  if (idea.unstructured === true || idea.title.trim() === '') {
    return idea.rationale;
  }
  return `title: ${idea.title}\none_liner: ${idea.one_liner}`;
}

/**
 * Synthetic ID for the dedupe merge map. Uses `author_model` + index so keys
 * are stable and interpretable across reruns (task 5.2: `author + index`
 * scheme vs the ideate `role + index` scheme).
 */
function syntheticId(idea: BrainstormIdea, index: number): string {
  return `${idea.author_model}#${index}`;
}

export async function runIdeaDedupePhase({
  ideas,
  opts,
}: RunIdeaDedupeInput): Promise<IdeaDedupeOutput> {
  if (ideas.length === 0) {
    return {
      ideas: [],
      warnings: [],
      phaseRecord: {
        phase: 'idea-dedupe',
        ideas: [],
        dedupe: {
          kept: [],
          merged_into: {},
          threshold: opts?.threshold ?? 0.85,
          provider: null,
          skipped: false,
        },
      },
    };
  }

  // Adapt BrainstormIdea → PhaseContribution for the shared dedupe primitive.
  const contributions: PhaseContribution[] = ideas.map((idea) => ({
    // role field used as the left side of the synthetic ID key in mergeMap.
    // We encode author_model#index so the merge map is interpretable.
    role: idea.author_model as PhaseContribution['role'],
    model: idea.author_model,
    content: ideaEmbedText(idea),
    timestamp: new Date().toISOString(),
  }));

  const result = await runDedupePhase(contributions, opts);

  // Build a lookup from synthetic ID → original idea index so we can
  // map survivor PhaseContributions back to their BrainstormIdea.
  const synIdToIndex = new Map<string, number>();
  for (let i = 0; i < ideas.length; i++) {
    synIdToIndex.set(syntheticId(ideas[i]!, i), i);
  }

  // `result.kept` is the surviving PhaseContributions. Match each back to its
  // original idea. The kept array preserves original order (dedupe never
  // reorders). We identify survivors by reconstructing their synthetic ID from
  // position in the original `ideas` array — the dedupe primitive preserves the
  // original draft reference, so we can use object identity.
  const keptIdeas: BrainstormIdea[] = [];
  for (const contribution of result.kept) {
    // Find which original idea this contribution came from via content match.
    // Object identity would be cleaner but PhaseContribution is a plain object.
    const idx = contributions.indexOf(contribution);
    if (idx === -1) continue;
    const original = ideas[idx]!;
    keptIdeas.push(original);
  }

  // Assign final stable idea_ids. Unstructured ideas keep their temp ID.
  const finalIdeas: BrainstormIdea[] = keptIdeas.map((idea) => {
    if (idea.unstructured === true || idea.title.trim() === '') {
      return idea;
    }
    return { ...idea, idea_id: stableIdeaId(idea.title, idea.one_liner) };
  });

  // Build the merge map with brainstorm-style synthetic IDs
  // (author_model#index → author_model#index, matching how dedupe emitted them).
  // The dedupe primitive uses `${role}#${index}` internally; we need to remap
  // those keys to our `author_model#index` scheme.
  const mergeMap: Record<string, string> = {};
  for (const [loserKey, survivorKey] of Object.entries(result.merged_into)) {
    // Keys from runDedupePhase are `${role}#${index}` where role = author_model
    // (we passed author_model as role). So these are already in the right form.
    mergeMap[loserKey] = survivorKey;
  }

  const warnings: string[] = [];
  if (result.skipped && result.warning) {
    warnings.push(result.warning);
  }

  const phaseRecord: BrainstormPhaseRecord = {
    phase: 'idea-dedupe',
    ideas: finalIdeas,
    dedupe: {
      kept: finalIdeas.map((idea, i) => idea.idea_id ?? syntheticId(idea, i)),
      merged_into: mergeMap,
      threshold: result.threshold,
      provider: result.provider,
      skipped: result.skipped,
    },
    warnings: warnings.length > 0 ? warnings : undefined,
  };

  return { ideas: finalIdeas, warnings, phaseRecord };
}
