/**
 * Forge-elaboration phase for brainstorm mode (Section 8).
 *
 * Opt-in continuation triggered by `mode === 'brainstorm/forge'`. For each of
 * the top-K ranked ideas, run a lightweight cooperative elaboration call that
 * expands the seed into a one-page-ish project sketch. Calls run in parallel;
 * one failure does not abort the others — failed elaborations surface with
 * `elaboration: null` and an `error` field populated.
 *
 * Architectural lock (design.md §80): this module MUST NOT import or call
 * `runIdeation` and MUST NOT import from `../ideate/orchestrator`. Forge MAY
 * share helpers with `runCooperativeBuild` conceptually, but we keep the
 * implementation inline so brainstorm stays decoupled from ideate's evolution.
 *
 * Eligibility rule (design.md §130): ideas with `final_score === null`
 * (both-judges-authored degenerate case) are NEVER forged. The orchestrator
 * filters them out before slicing top-K.
 *
 * Spec: `openspec/changes/add-brainstorm-mode/tasks.md` Section 8.
 */

import type { AdapterFactory } from './orchestrator.js';
import type { BrainstormRankedIdea, ForgeElaboration } from './types.js';
import { forgeElaborationPrompt } from './prompts.js';

/**
 * Elaborate a single ranked idea. Returns a `ForgeElaboration` regardless of
 * success: on failure, `elaboration` is `null` and `error` carries the message.
 * Never throws — best-effort by contract.
 */
export async function elaborateIdea(
  idea: BrainstormRankedIdea,
  runPrompt: string,
  model: string,
  factory: AdapterFactory,
): Promise<ForgeElaboration> {
  const timestamp = new Date().toISOString();
  try {
    const adapter = factory(model);
    const { system, user } = forgeElaborationPrompt({
      prompt: runPrompt,
      idea: {
        idea_id: idea.idea_id,
        title: idea.title,
        one_liner: idea.one_liner,
        dimensions: idea.dimensions,
        rationale: idea.rationale,
        cluster: idea.cluster,
      },
    });
    const result = await adapter.generate(user, system);
    const text = typeof result.content === 'string' ? result.content.trim() : '';
    if (text === '') {
      return {
        idea_id: idea.idea_id,
        elaboration: null,
        model,
        timestamp,
        error: 'forge-elaboration: empty response from model',
      };
    }
    return {
      idea_id: idea.idea_id,
      elaboration: text,
      model,
      timestamp,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      idea_id: idea.idea_id,
      elaboration: null,
      model,
      timestamp,
      error: `forge-elaboration: ${message}`,
    };
  }
}

/**
 * Run `elaborateIdea` in parallel over the top-K eligible ideas from the rank
 * phase. Order matches the input order (which is the descending-rank order
 * from `runRankPhase`).
 *
 * Eligibility: ideas with `final_score === null` are filtered out before
 * slicing — they were author-skipped by every judge and have no signal to
 * justify spending an elaboration call.
 *
 * `k <= 0` returns an empty array (no-op); `k` larger than the eligible set
 * elaborates every eligible idea.
 */
export async function forgeTopK(
  rankedIdeas: readonly BrainstormRankedIdea[],
  runPrompt: string,
  k: number,
  model: string,
  factory: AdapterFactory,
): Promise<readonly ForgeElaboration[]> {
  if (k <= 0) return [];
  const eligible = rankedIdeas.filter((i) => i.final_score !== null);
  const top = eligible.slice(0, k);
  if (top.length === 0) return [];
  return Promise.all(top.map((idea) => elaborateIdea(idea, runPrompt, model, factory)));
}
