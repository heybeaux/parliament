/**
 * Defense phase prompt and parser.
 * Implements the structured defense logic for ideate-mode.
 */

import type { DefenseEntry, Problem } from './types.js';

export const DEFENSE_SYSTEM_PROMPT = `You are a cooperative author defending your product idea against structured critiques.

# Your Goal
For each provided critique, you must decide whether to "address" the flaw or "double down" on your original position.

# Response Format
You MUST respond in valid JSON format. Do not include markdown blocks or preamble.

Shape:
{
  "defenses": [
    {
      "critique_id": "string",
      "stance": "address" | "double_down",
      "reasoning": "3-5 sentence explanation of why you are taking this stance.",
      "draft_delta": "REQUIRED ONLY IF stance is 'address'. Provide the specific revised text or a detailed description of how the idea changes to fix the problem."
    }
  ]
}

# Stance Guidelines
- "address": You acknowledge the critique is valid and propose a concrete fix.
- "double_down": You believe the critique misses the point, is based on a false premise, or that the trade-off is acceptable.
`;

export const DEFENSE_RETRY_INSTRUCTION = `Your previous response was not valid JSON or missed required fields. Please respond ONLY with the JSON object described in the system prompt.`;

export interface ParsedDefense {
  defenses: DefenseEntry[];
}

/**
 * Parses the model's defense output into structured entries.
 * Throws if JSON is invalid or required fields are missing.
 */
export function parseDefenseOutput(content: string): ParsedDefense | null {
  try {
    const cleaned = content.replace(/```json\n?|```/g, '').trim();
    const parsed = JSON.parse(cleaned);

    if (!parsed.defenses || !Array.isArray(parsed.defenses)) return null;

    const validDefenses: DefenseEntry[] = [];
    for (const d of parsed.defenses) {
      if (!d.critique_id || !d.stance || !d.reasoning) continue;
      if (d.stance === 'address' && !d.draft_delta) continue;
      validDefenses.push(d);
    }

    return { defenses: validDefenses };
  } catch {
    return null;
  }
}

/**
 * Builds the user prompt for the defense phase.
 */
export function buildDefenseUserPrompt(
  idea: string,
  draft: string,
  critiques: readonly Problem[],
  mode: string,
): string {
  // Group critiques by dimension for better author organization
  const dimensions = Array.from(new Set(critiques.map((p) => p.dimension)));
  const groupedCritiques = dimensions.map((dim) => {
    const dimCritiques = critiques
      .filter((p) => p.dimension === dim)
      .map((p, i) => `  - [ID: ${i}] Problem: ${p.problem}\n    Fix: ${p.proposed_fix}`)
      .join('\n');
    return `### ${dim.toUpperCase()}\n${dimCritiques}`;
  }).join('\n\n');

  const modeInstruction = 
    mode === 'address' ? 'You MUST "address" every critique.' :
    mode === 'double_down' ? 'You MUST "double down" on every critique.' :
    'Choose the most honest stance ("address" or "double_down") for each critique.';

  return [
    `# Original Idea\n${idea}`,
    `# Your Draft\n${draft}`,
    `# Critiques by Dimension\n${groupedCritiques}`,
    `# Instructions\n${modeInstruction}`
  ].join('\n\n');
}
