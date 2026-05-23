/**
 * Structured adversarial output — prompt template + parser.
 *
 * Adversarial agents in `adversarial` and `full` sub-modes MUST emit JSON
 * matching `{ "problems": [{ "problem": string, "proposed_fix": string }, ...] }`.
 * The orchestrator parses once, retries once on failure with a stricter
 * "JSON only" instruction, and falls back to preserving raw prose on a
 * second failure (per spec — "Adversarial output fails twice" scenario).
 *
 * Parser strategy mirrors `agents/synthesizer.ts` (three layers: strict
 * parse → fenced-block extraction → balanced-brace fallback) so small open
 * models that wrap output in ```json fences``` still produce structured
 * results without a re-prompt round trip.
 */

import type { Problem, ProblemDimension } from './types.js';

/** Closed enum for problem dimensions (`refine-ideate-forge`). */
export const PROBLEM_DIMENSIONS: readonly ProblemDimension[] = [
  'ux',
  'business',
  'technical',
  'market',
  'legal',
  'other',
];

/** Adversarial prompt template — used by `compileAdversarialPhase`. */
export const ADVERSARIAL_SYSTEM_PROMPT = [
  'You are an adversarial reviewer evaluating a product idea. Your role is NOT to',
  'be reflexively negative — your role is to surface specific problems with the',
  'idea AND propose concrete fixes for each one. An idea you cannot poke any holes',
  'in is one you have not thought hard enough about.',
  '',
  'You MUST output ONLY a single JSON object with no surrounding prose, no markdown',
  'fences, and no commentary. The JSON object MUST conform to this exact schema:',
  '',
  '{"problems": [{"problem": "<one sentence describing a specific problem>",',
  '               "proposed_fix": "<one or two sentences describing a concrete fix>",',
  '               "dimension": "ux"|"business"|"technical"|"market"|"legal"|"other"},',
  '              ...]}',
  '',
  'Field semantics:',
  '- problems: array of at least 1 and at most 5 problem-fix pairs. Quality > quantity.',
  '- problem: a specific, concrete failure mode — not a vague concern.',
  '- proposed_fix: an actionable change that would address the problem.',
  '- dimension: REQUIRED. One of: ux (user experience / usability),',
  '  business (model, pricing, distribution), technical (build cost, scaling,',
  '  reliability), market (demand, competition, timing), legal (regulation,',
  '  IP, liability), or other (use sparingly — pick a specific dimension when',
  '  possible).',
  '',
  'Output ONLY the JSON object. No preamble, no markdown, no trailing commentary.',
].join('\n');

/** Stricter re-prompt used when the first attempt does not parse. */
export const ADVERSARIAL_RETRY_INSTRUCTION =
  "Your previous response wasn't valid JSON. Output ONLY the JSON object with the " +
  '"problems" array — each entry MUST include `problem`, `proposed_fix`, AND ' +
  '`dimension` (one of ux/business/technical/market/legal/other). Do not include ' +
  'markdown fences or commentary.';

interface ParsedAdversarial {
  problems: Problem[];
}

/**
 * Parses raw model output into a `Problem[]`, returning `null` on any
 * structural failure. The orchestrator decides what to do with `null` (one
 * retry, then prose fallback).
 */
export function parseAdversarialOutput(raw: string): readonly Problem[] | null {
  const parsed = extractJsonObject(raw);
  if (parsed === null) return null;
  if (!Array.isArray(parsed.problems)) return null;
  if (parsed.problems.length === 0) return null;

  const out: Problem[] = [];
  for (const entry of parsed.problems) {
    if (typeof entry !== 'object' || entry === null) return null;
    const e = entry as unknown as Record<string, unknown>;
    if (typeof e['problem'] !== 'string' || (e['problem'] as string).trim().length === 0) {
      return null;
    }
    if (typeof e['proposed_fix'] !== 'string' || (e['proposed_fix'] as string).trim().length === 0) {
      return null;
    }
    // `dimension` REQUIRED post-refine. Missing or unknown values cause the
    // whole adversarial output to be rejected; the orchestrator then runs
    // the standard one-shot retry with a stricter instruction, falling back
    // to prose preservation if the second attempt also fails.
    const dim = e['dimension'];
    if (typeof dim !== 'string') return null;
    if (!PROBLEM_DIMENSIONS.includes(dim as ProblemDimension)) return null;
    out.push({
      problem: (e['problem'] as string).trim(),
      proposed_fix: (e['proposed_fix'] as string).trim(),
      dimension: dim as ProblemDimension,
    });
  }
  return out;
}

function extractJsonObject(raw: string): ParsedAdversarial | null {
  const strict = tryParse(raw.trim());
  if (strict !== null) return strict;

  // Fenced ```json ... ``` block.
  const fence = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fence !== null && typeof fence[1] === 'string') {
    const fenced = tryParse(fence[1].trim());
    if (fenced !== null) return fenced;
  }

  // Balanced-brace fallback — first {...} that parses cleanly.
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

function tryParse(text: string): ParsedAdversarial | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    if (!('problems' in parsed)) return null;
    return parsed as ParsedAdversarial;
  } catch {
    return null;
  }
}
