/**
 * Brainstorm prompt templates.
 *
 * Each exported function takes a typed input and returns `{ system, user }`
 * so callers can pass them directly to `adapter.generate(user, system)`.
 *
 * Sections populated here:
 *   4 — divergentAuthorPrompt (divergent-generation phase)
 *   6 — clusterPrompt (cluster phase)
 *   7 — rankPrompt (rank phase) — stub placeholder
 *
 * Spec: `openspec/changes/add-brainstorm-mode/specs/brainstorm-mode/spec.md`.
 */

import type { BrainstormIdea } from './types.js';

export interface PromptPair {
  system: string;
  user: string;
}

export interface DivergentAuthorPromptInput {
  prompt: string;
  ideasPerAuthor: number;
  authorModel: string;
}

/**
 * Builds the system + user prompt for one divergent-generation author.
 *
 * Anti-convergence framing: the author knows it is one of several running in
 * parallel. The goal is breadth — the obvious idea is already covered, so
 * reach for something unexpected. Polish is irrelevant at this stage.
 */
export function divergentAuthorPrompt({
  prompt,
  ideasPerAuthor,
  authorModel: _authorModel,
}: DivergentAuthorPromptInput): PromptPair {
  const system = [
    'You are one of four independent brainstorm authors generating project ideas in parallel.',
    'Your peers are running concurrently with the same prompt — you will never see their output.',
    '',
    'Your job is BREADTH, not polish. Assume the obvious idea is already covered.',
    'Reach for unexpected angles: different domains, inverted assumptions, unconventional',
    'audiences, or approaches that feel risky or weird. One strong contrarian idea beats',
    'four safe ones.',
    '',
    'You MUST output ONLY a single JSON object with no surrounding prose, no markdown',
    'fences, and no commentary. The JSON object MUST conform to this exact schema:',
    '',
    '{"ideas": [',
    '  {',
    '    "title": "<short memorable name, 2–6 words>",',
    '    "one_liner": "<one sentence that captures the core proposition>",',
    '    "dimensions": {',
    '      "problem": "<what problem does this solve>",',
    '      "audience": "<who is the primary user or beneficiary>",',
    '      "mechanism": "<how does it work at a high level>"',
    '    },',
    '    "rationale": "<1–3 sentences on why this direction is worth exploring>"',
    '  },',
    '  ...',
    ']}',
    '',
    'Field rules:',
    '- title: 2–6 words, no punctuation at the end.',
    '- one_liner: exactly one sentence.',
    '- dimensions: object with "problem", "audience", and "mechanism" string fields.',
    '- rationale: 1–3 sentences. Focus on what makes this direction non-obvious.',
    '',
    'Output ONLY the JSON object. No preamble, no markdown, no trailing commentary.',
  ].join('\n');

  const user = [
    `Generate exactly ${ideasPerAuthor} project ${ideasPerAuthor === 1 ? 'idea' : 'ideas'} for the following prompt:`,
    '',
    prompt,
    '',
    `Return a JSON object with an "ideas" array containing exactly ${ideasPerAuthor} ${ideasPerAuthor === 1 ? 'entry' : 'entries'}.`,
    'Prioritise novelty and breadth. Do not converge on the most obvious interpretation.',
  ].join('\n');

  return { system, user };
}

/** Retry instruction sent when the first parse attempt fails. */
export const DIVERGENT_RETRY_INSTRUCTION =
  "Your previous response wasn't valid JSON. Output ONLY the JSON object with an " +
  '"ideas" array. Each entry MUST include "title" (string), "one_liner" (string), ' +
  '"dimensions" (object with "problem", "audience", "mechanism" string fields), and ' +
  '"rationale" (string). No markdown fences, no commentary.';

// ---------------------------------------------------------------------------
// Cluster phase (Section 6)
// ---------------------------------------------------------------------------

export interface ClusterPromptInput {
  /** Original user brainstorm prompt — gives the clusterer context. */
  prompt: string;
  /** Deduped survivors that need clustering. */
  ideas: readonly BrainstormIdea[];
}

/**
 * Builds the system + user prompt for the cluster phase.
 *
 * The clusterer is a single model (Opus 4.6 by default) that takes the
 * deduped survivor ideas and emits a cluster_map: label → [idea_id, ...].
 * Labels are model-generated free-form strings (per design.md — no taxonomy
 * in v1). Cluster output is advisory: it serves as a UI hint and a rank-phase
 * context primer, but does not affect scoring directly.
 *
 * Output shape is the same shape we'll persist on the phase record so the
 * rank phase can consume it directly. Every surviving `idea_id` MUST appear
 * in exactly one cluster.
 */
export function clusterPrompt({
  prompt,
  ideas,
}: ClusterPromptInput): PromptPair {
  const system = [
    'You are a brainstorm clusterer. You take a flat list of candidate project',
    'ideas and group them into thematic clusters.',
    '',
    'Your job is to find the natural thematic groups in this set of ideas, and',
    'to label each group with a short descriptive phrase. Clusters are advisory',
    'context for downstream judges — they do not change which ideas survive.',
    '',
    'Rules:',
    '- Every idea_id MUST appear in exactly one cluster (no duplicates, no orphans).',
    '- Cluster labels are 2–6 word free-form phrases. No taxonomy, no schema.',
    '- Aim for 2–6 clusters total. Fewer is fine if the set is small or homogeneous.',
    '- A single-idea cluster is acceptable when the idea is a genuine outlier.',
    '',
    'You MUST output ONLY a single JSON object with no surrounding prose, no markdown',
    'fences, and no commentary. The JSON object MUST conform to this exact schema:',
    '',
    '{"clusters": [',
    '  {',
    '    "label": "<2–6 word cluster name>",',
    '    "idea_ids": ["<idea_id>", "<idea_id>", ...]',
    '  },',
    '  ...',
    ']}',
    '',
    'Output ONLY the JSON object. No preamble, no markdown, no trailing commentary.',
  ].join('\n');

  const ideaLines = ideas.map(
    (i) => `- ${i.idea_id}: ${i.title} — ${i.one_liner}`,
  );

  const user = [
    'The original brainstorm prompt was:',
    '',
    prompt,
    '',
    `Cluster the following ${ideas.length} candidate ${ideas.length === 1 ? 'idea' : 'ideas'} into 2–6 thematic groups.`,
    'Use the idea_id values exactly as given:',
    '',
    ...ideaLines,
    '',
    'Return a JSON object with a "clusters" array. Every idea_id above MUST appear in exactly one cluster.',
  ].join('\n');

  return { system, user };
}

/** Retry instruction sent when the first cluster parse attempt fails. */
export const CLUSTER_RETRY_INSTRUCTION =
  "Your previous response wasn't valid JSON. Output ONLY the JSON object with a " +
  '"clusters" array. Each entry MUST include "label" (string) and "idea_ids" ' +
  '(array of strings). Every idea_id from the input MUST appear in exactly one ' +
  'cluster. No markdown fences, no commentary.';

// ---------------------------------------------------------------------------
// Rank phase (Section 7)
// ---------------------------------------------------------------------------

/** One-line definitions surfaced to judges so scoring stays anchored. */
export const CRITERIA_DEFINITIONS: Readonly<Record<string, string>> = {
  novelty: 'How different is this idea from what already exists in this space?',
  feasibility: 'Could a small team realistically ship a v1 in 90 days?',
  fit: "How well does this match the prompt's intent and constraints?",
  evidence: 'How strong is the underlying signal that this is worth building?',
};

export interface RankPromptInput {
  /** Original user brainstorm prompt. */
  prompt: string;
  /** Surviving (post-dedupe, post-cluster) ideas to be scored. */
  ideas: readonly {
    idea_id: string;
    title: string;
    one_liner: string;
    dimensions: readonly string[];
    rationale: string;
    cluster?: string | null;
  }[];
  /** Map from cluster label to member idea_ids (advisory context). */
  clusterMap?: Readonly<Record<string, readonly string[]>>;
  /** Judge's own model ID — used to caveat self-authored ideas in-prompt. */
  judgeModel: string;
}

/**
 * Builds the system + user prompt for one ranking judge.
 *
 * Judges run independently and in parallel — no cross-judge anchoring. Each
 * judge sees the full surviving-idea set, cluster labels for context, and the
 * four locked criteria with one-line definitions. The judge MUST emit per-idea
 * per-criterion integer scores (0–10) with a brief rationale per idea.
 *
 * Author-aware skipping is enforced by the orchestrator post-hoc: the judge
 * may still score every idea, but scores for ideas authored by this judge's
 * model are discarded before averaging. The prompt nevertheless asks the
 * judge to be self-aware about scoring its own output.
 */
export function rankPrompt({
  prompt,
  ideas,
  clusterMap,
  judgeModel: _judgeModel,
}: RankPromptInput): PromptPair {
  const system = [
    'You are an independent judge scoring candidate project ideas from a',
    'brainstorm session. Other judges are running concurrently — you will',
    'never see their scores. Score independently and honestly.',
    '',
    'You will score every idea on FOUR fixed criteria, each on an integer',
    'scale 0–10, with a one-line rationale per idea:',
    '',
    `- novelty (0–10): ${CRITERIA_DEFINITIONS['novelty']}`,
    `- feasibility (0–10): ${CRITERIA_DEFINITIONS['feasibility']}`,
    `- fit (0–10): ${CRITERIA_DEFINITIONS['fit']}`,
    `- evidence (0–10): ${CRITERIA_DEFINITIONS['evidence']}`,
    '',
    'Scoring guidance:',
    '- 0 means the idea fails this criterion entirely; 10 means exceptional.',
    '- Use the full range. Avoid clustering scores in the middle.',
    '- Score each idea on its own merits; do not normalize relative to peers.',
    '- Cluster labels are advisory context, NOT a scoring axis.',
    '',
    'You MUST output ONLY a single JSON object with no surrounding prose, no',
    'markdown fences, and no commentary. The JSON object MUST conform to this',
    'exact schema:',
    '',
    '{"scores": [',
    '  {',
    '    "idea_id": "<idea_id as provided>",',
    '    "novelty": <integer 0-10>,',
    '    "feasibility": <integer 0-10>,',
    '    "fit": <integer 0-10>,',
    '    "evidence": <integer 0-10>,',
    '    "rationale": "<one sentence summarizing your scoring>"',
    '  },',
    '  ...',
    ']}',
    '',
    'Every idea_id from the input list MUST appear exactly once in the scores',
    'array. Output ONLY the JSON object. No preamble, no markdown, no commentary.',
  ].join('\n');

  const ideaLines = ideas.map((i) => {
    const dims = Array.isArray(i.dimensions) ? i.dimensions.join(' / ') : '';
    const clusterTag = i.cluster !== undefined && i.cluster !== null ? ` [cluster: ${i.cluster}]` : '';
    return [
      `- ${i.idea_id}${clusterTag}`,
      `    title: ${i.title}`,
      `    one_liner: ${i.one_liner}`,
      dims !== '' ? `    dimensions: ${dims}` : '',
      `    rationale: ${i.rationale}`,
    ]
      .filter((s) => s !== '')
      .join('\n');
  });

  const clusterLines: string[] = [];
  if (clusterMap !== undefined && Object.keys(clusterMap).length > 0) {
    clusterLines.push('Cluster context (advisory):');
    for (const [label, ids] of Object.entries(clusterMap)) {
      clusterLines.push(`- ${label}: ${ids.join(', ')}`);
    }
    clusterLines.push('');
  }

  const user = [
    'The original brainstorm prompt was:',
    '',
    prompt,
    '',
    ...clusterLines,
    `Score the following ${ideas.length} candidate ${ideas.length === 1 ? 'idea' : 'ideas'}.`,
    'Use the idea_id values exactly as given:',
    '',
    ...ideaLines,
    '',
    'Return a JSON object with a "scores" array containing one entry per idea_id.',
  ].join('\n');

  return { system, user };
}

/** Retry instruction sent when the first rank parse attempt fails. */
export const RANK_RETRY_INSTRUCTION =
  "Your previous response wasn't valid JSON. Output ONLY the JSON object with a " +
  '"scores" array. Each entry MUST include "idea_id" (string), "novelty", ' +
  '"feasibility", "fit", "evidence" (each integer 0-10), and "rationale" (string). ' +
  'Every idea_id from the input MUST appear exactly once. No markdown fences, no commentary.';

// ---------------------------------------------------------------------------
// Forge phase (Section 8)
// ---------------------------------------------------------------------------

export interface ForgeElaborationPromptInput {
  /** Original brainstorm prompt — gives the elaborator context. */
  prompt: string;
  /** One ranked idea to elaborate. */
  idea: {
    idea_id: string;
    title: string;
    one_liner: string;
    dimensions: readonly string[];
    rationale: string;
    cluster?: string | null;
  };
}

/**
 * Builds the system + user prompt for one forge-elaboration call.
 *
 * Forge is a lightweight cooperative elaboration of a single top-K idea: the
 * elaborator expands the seed into a one-page-ish project sketch. Output is
 * free-form prose (NOT JSON) — the elaboration is surfaced verbatim to the
 * caller, so there's no parse step and no retry.
 *
 * Design note (design.md §80): forge MAY share helpers with
 * `runCooperativeBuild`, but is its own entry point. We keep the prompt
 * self-contained here rather than reaching into ideate so brainstorm stays
 * decoupled (and so the no-ideate-coupling architectural lock holds).
 */
export function forgeElaborationPrompt({
  prompt,
  idea,
}: ForgeElaborationPromptInput): PromptPair {
  const system = [
    'You are elaborating a single candidate project idea from a brainstorm session',
    'into a one-page-ish project sketch. You will not see the other candidates.',
    '',
    'Your job is to take the seed idea and develop it into something a small team',
    'could actually build. Be concrete: name the user, name the first version, name',
    'what success looks like in 90 days. Cover the obvious risks honestly.',
    '',
    'Suggested structure (use as a guide, not a rigid template):',
    '- One-paragraph framing of what this is and why it matters now.',
    '- Target user and the specific pain you remove.',
    '- The smallest version that could ship in 90 days (v1 scope).',
    '- The mechanism — how it actually works at a technical level.',
    '- Two or three honest risks or open questions.',
    '- A one-line success criterion for v1.',
    '',
    'Output free-form prose with light markdown (headings, bullets) at most. No',
    'preamble, no meta-commentary about the task — write as if you are handing the',
    'sketch to a builder.',
  ].join('\n');

  const dims = idea.dimensions.length > 0 ? idea.dimensions.join(' / ') : '';
  const clusterTag =
    idea.cluster !== undefined && idea.cluster !== null && idea.cluster !== ''
      ? `\nCluster: ${idea.cluster}`
      : '';

  const user = [
    'The original brainstorm prompt was:',
    '',
    prompt,
    '',
    'The seed idea to elaborate:',
    '',
    `Title: ${idea.title}`,
    `One-liner: ${idea.one_liner}`,
    dims !== '' ? `Dimensions: ${dims}` : '',
    `Rationale: ${idea.rationale}${clusterTag}`,
    '',
    'Elaborate this idea into a one-page-ish project sketch.',
  ]
    .filter((s) => s !== '')
    .join('\n');

  return { system, user };
}
