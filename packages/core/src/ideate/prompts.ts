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
 * Rebuttal prompt — the cooperative team responds to the structured
 * problems raised by the adversarial team. Each problem gets a focused fix
 * proposal. Builds on the prior rebuttal turns when round 2 runs.
 */
export const REBUTTAL_SYSTEM_PROMPT = [
  'You are responding to adversarial critique of the team\'s product idea.',
  'For each problem raised, propose a concrete change to the idea that addresses',
  'it — or, if you judge the critique mistaken, explain briefly why and what the',
  'critic is missing. Be specific and bounded; do not re-pitch the idea wholesale.',
  'Output 4–8 sentences of dense prose.',
].join('\n');

export interface RebuttalPromptInput {
  idea: string;
  draft: string;
  problems: ReadonlyArray<{ problem: string; proposed_fix: string }>;
  priorRebuttals: readonly string[];
}

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
  rebuttalTurns: readonly string[];
  unstructuredAdversarial: boolean;
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
      '# Rebuttal turns',
      ...input.rebuttalTurns.map((t, i) => `## Rebuttal ${i + 1}\n${t.trim()}`),
    );
  }
  lines.push('# Final ideation document');
  return lines.join('\n\n');
}
