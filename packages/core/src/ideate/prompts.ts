/**
 * Per-role system prompts for ideate. Distinct from the deliberation
 * neurotypes because ideate operates on a single product idea (not a
 * debate topic) and the cooperative roles aim at "better idea" rather
 * than "more truthful belief."
 */

import type { LineupRole } from './types.js';

export const COOPERATIVE_PROMPTS: Record<
  Exclude<LineupRole, 'skeptic' | 'devils-advocate'>,
  string
> = {
  proposer: [
    'You are the Proposer in a cooperative product-ideation team.',
    'Your job is to ground the idea in a concrete, testable shape: who it serves,',
    'what it does end-to-end, and the smallest version that would prove the concept.',
    'Be specific. Avoid vague aspirations. Output 4–8 sentences of dense prose.',
  ].join('\n'),
  expander: [
    'You are the Expander in a cooperative product-ideation team.',
    'Your job is to broaden the idea: surface adjacent use cases, second-order effects,',
    'and unexpected user segments. Build ON the team\'s existing thinking — do not',
    'restart from scratch. Output 4–8 sentences of dense prose.',
  ].join('\n'),
  pragmatist: [
    'You are the Pragmatist in a cooperative product-ideation team.',
    'Your job is to ground the idea in shipping reality: build cost, distribution,',
    'sequencing, and the smallest credible path to revenue or adoption. Build ON the',
    'team\'s existing thinking — do not restart. Output 4–8 sentences of dense prose.',
  ].join('\n'),
  lateralist: [
    'You are the Lateralist in a cooperative product-ideation team.',
    'Your job is to find non-obvious angles: analogies from other domains, inversions',
    'of standard assumptions, or reframings that reveal hidden structure. Build ON the',
    'team\'s existing thinking — do not restart. Output 4–8 sentences of dense prose.',
  ].join('\n'),
};

/**
 * Cooperative-build user prompt builder. In `collective` style each agent
 * sees the prior turns so far; in `individual` style each agent sees only
 * the original idea. The orchestrator decides which view to pass.
 */
export function buildCooperativeUserPrompt(idea: string, priorTurns: readonly string[]): string {
  const lines: string[] = [`# Idea\n\n${idea.trim()}`];
  if (priorTurns.length > 0) {
    lines.push('# Prior team turns', ...priorTurns.map((t, i) => `## Turn ${i + 1}\n${t.trim()}`));
  }
  lines.push('# Your contribution');
  return lines.join('\n\n');
}

/**
 * Defense prompt — the cooperative team responds to the structured
 * problems raised by the adversarial team. Each problem gets a per-critique
 * STANCE (`address` rewrites the relevant draft slice; `double_down` keeps
 * position and justifies). The defense_mode parameter controls whether the
 * author picks per critique (`author_choice`) or the orchestrator forces a
 * single stance for every defense.
 *
 * Output is structured JSON:
 *   { defenses: [
 *       { critique_id, stance: 'address'|'double_down', reasoning,
 *         draft_delta?: string }
 *     ] }
 *
 * Spec: `openspec/changes/refine-ideate-forge/specs/ideate-mode/spec.md`.
 */
export type DefenseMode = 'address' | 'double_down' | 'author_choice';

export const DEFENSE_SYSTEM_PROMPT_AUTHOR_CHOICE = [
  'You are responding to adversarial critique of the team\'s product idea.',
  'For each problem raised, pick a stance per critique:',
  '  - "address": revise the relevant slice of the draft to fix the problem.',
  '  - "double_down": keep your position and explain in one paragraph why the',
  '    critic is missing the point.',
  '',
  'Output ONLY a single JSON object with no surrounding prose:',
  '',
  '{"defenses": [',
  '  {"critique_id": "<id>",',
  '   "stance": "address" | "double_down",',
  '   "reasoning": "<one or two sentences>",',
  '   "draft_delta": "<the revised slice — REQUIRED when stance is address, omit on double_down>"',
  '  }, ...',
  ']}',
  '',
  'Include exactly one defense per critique. Output ONLY the JSON object.',
].join('\n');

export const DEFENSE_SYSTEM_PROMPT_ADDRESS_FORCED = [
  'You are responding to adversarial critique of the team\'s product idea.',
  'For every critique you MUST take stance "address": revise the relevant',
  'slice of the draft to fix the problem. `double_down` is NOT permitted in',
  'this run.',
  '',
  'Output ONLY a single JSON object with no surrounding prose:',
  '',
  '{"defenses": [',
  '  {"critique_id": "<id>",',
  '   "stance": "address",',
  '   "reasoning": "<one or two sentences>",',
  '   "draft_delta": "<the revised slice — REQUIRED>"',
  '  }, ...',
  ']}',
  '',
  'Include exactly one defense per critique. Output ONLY the JSON object.',
].join('\n');

export const DEFENSE_SYSTEM_PROMPT_DOUBLE_DOWN_FORCED = [
  'You are responding to adversarial critique of the team\'s product idea.',
  'For every critique you MUST take stance "double_down": keep your position',
  'and explain in one paragraph why the critic is missing the point.',
  '`address` is NOT permitted in this run.',
  '',
  'Output ONLY a single JSON object with no surrounding prose:',
  '',
  '{"defenses": [',
  '  {"critique_id": "<id>",',
  '   "stance": "double_down",',
  '   "reasoning": "<one paragraph explaining the position>"',
  '  }, ...',
  ']}',
  '',
  'Do NOT include `draft_delta`. Include exactly one defense per critique.',
  'Output ONLY the JSON object.',
].join('\n');

/**
 * Backward-compat: the old "rebuttal" prose prompt is preserved as an
 * alias of the author-choice defense prompt for any external consumer
 * that imported `REBUTTAL_SYSTEM_PROMPT` directly.
 *
 * @deprecated Use one of the `DEFENSE_SYSTEM_PROMPT_*` constants.
 */
export const REBUTTAL_SYSTEM_PROMPT = DEFENSE_SYSTEM_PROMPT_AUTHOR_CHOICE;

export const DEFENSE_RETRY_INSTRUCTION =
  "Your previous response wasn't valid JSON for the defense schema. Output ONLY " +
  'the JSON object with the "defenses" array, nothing else.';

export interface DefensePromptInput {
  idea: string;
  draft: string;
  problems: ReadonlyArray<{
    critique_id: string;
    problem: string;
    proposed_fix: string;
    dimension: string;
  }>;
  mode: DefenseMode;
}

export function buildDefenseUserPrompt(input: DefensePromptInput): string {
  const lines: string[] = [
    `# Idea\n\n${input.idea.trim()}`,
    `# Draft synthesis so far\n\n${input.draft.trim()}`,
    '# Critiques',
    ...input.problems.map(
      (p) =>
        `- id: \`${p.critique_id}\`\n  dimension: ${p.dimension}\n  problem: ${p.problem}\n  proposed_fix: ${p.proposed_fix}`,
    ),
  ];
  if (input.mode === 'address') {
    lines.push('# Reminder', 'Every defense MUST use stance "address".');
  } else if (input.mode === 'double_down') {
    lines.push('# Reminder', 'Every defense MUST use stance "double_down".');
  }
  lines.push('# Your structured defense');
  return lines.join('\n\n');
}

/**
 * Back-compat alias for the pre-refine `buildRebuttalUserPrompt` shape.
 *
 * @deprecated Use `buildDefenseUserPrompt` with the new structured input.
 */
export interface RebuttalPromptInput {
  idea: string;
  draft: string;
  problems: ReadonlyArray<{ problem: string; proposed_fix: string }>;
  priorRebuttals: readonly string[];
}

/**
 * @deprecated Use `buildDefenseUserPrompt`. This alias preserves the
 * pre-refine builder shape for external consumers; internally the
 * orchestrator now uses the structured defense flow.
 */
export function buildRebuttalUserPrompt(input: RebuttalPromptInput): string {
  const lines: string[] = [
    `# Idea\n\n${input.idea.trim()}`,
    `# Draft synthesis so far\n\n${input.draft.trim()}`,
    '# Problems raised',
    ...input.problems.map(
      (p, i) => `${i + 1}. **Problem:** ${p.problem}\n   **Proposed fix:** ${p.proposed_fix}`,
    ),
  ];
  if (input.priorRebuttals.length > 0) {
    lines.push(
      '# Prior rebuttal turns',
      ...input.priorRebuttals.map((r, i) => `## Rebuttal ${i + 1}\n${r.trim()}`),
    );
  }
  lines.push('# Your response');
  return lines.join('\n\n');
}

/**
 * Synthesis prompt — produces the final ideation document. Plain prose
 * (not JSON like the deliberation synthesizer) because the consumer is a
 * reader, not the deliberation engine. Two paragraphs: the synthesized
 * idea and the open questions / next steps.
 */
export const SYNTH_SYSTEM_PROMPT = [
  'You are synthesizing a product-ideation transcript into a final ideation document.',
  'The transcript has multiple cooperative turns and may include adversarial critique',
  'and rebuttal turns. Your job is to produce a single, coherent ideation document — not',
  'a meeting summary. Lead with the strongest version of the idea. Then surface what',
  'remains genuinely uncertain or contested.',
  '',
  'Output two short paragraphs in plain prose, no markdown headings, no bullet points.',
].join('\n');

export interface SynthPromptInput {
  idea: string;
  cooperativeTurns: readonly string[];
  adversarialTurns: readonly string[];
  /**
   * Defense turns (previously "rebuttal"). Field name kept stable for
   * minimal churn in callers; semantically these are now the structured
   * defense outputs rendered to prose for the synthesizer.
   */
  rebuttalTurns: readonly string[];
  unstructuredAdversarial: boolean;
  /**
   * Optional dimension grouping hint — when present, the synthesizer is
   * told to group critiques by dimension and weight them in synthesis.
   * Field is additive; callers from before the refine change can omit it.
   */
  dimensionsSummary?: string;
}

export function buildSynthUserPrompt(input: SynthPromptInput): string {
  const lines: string[] = [`# Original idea\n\n${input.idea.trim()}`];
  if (input.cooperativeTurns.length > 0) {
    lines.push(
      '# Cooperative team turns',
      ...input.cooperativeTurns.map((t, i) => `## Turn ${i + 1}\n${t.trim()}`),
    );
  }
  if (input.adversarialTurns.length > 0) {
    const note = input.unstructuredAdversarial
      ? '\n\n_Note: one or more adversarial agents emitted unstructured prose; treat their input as best-effort critique without the structured problem/fix shape._'
      : '';
    lines.push(
      `# Adversarial critique${note}`,
      ...input.adversarialTurns.map((t, i) => `## Critique ${i + 1}\n${t.trim()}`),
    );
  }
  if (input.rebuttalTurns.length > 0) {
    lines.push(
      '# Defense turns',
      ...input.rebuttalTurns.map((t, i) => `## Defense ${i + 1}\n${t.trim()}`),
    );
  }
  if (input.dimensionsSummary !== undefined && input.dimensionsSummary.length > 0) {
    lines.push(
      '# Critique dimension grouping',
      input.dimensionsSummary,
      'Group critiques by dimension in your synthesis. Treat legal critiques as load-bearing; UX/business/technical/market critiques as priorities to weigh; `other` as advisory.',
    );
  }
  lines.push('# Final ideation document');
  return lines.join('\n\n');
}
