/**
 * Brainstorm prompt templates.
 *
 * Each exported function takes a typed input and returns `{ system, user }`
 * so callers can pass them directly to `adapter.generate(user, system)`.
 *
 * Sections populated here:
 *   4 — divergentAuthorPrompt (divergent-generation phase)
 *   6 — clusterPrompt (cluster phase) — stub placeholder
 *   7 — rankPrompt (rank phase) — stub placeholder
 *
 * Spec: `openspec/changes/add-brainstorm-mode/specs/brainstorm-mode/spec.md`.
 */

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
