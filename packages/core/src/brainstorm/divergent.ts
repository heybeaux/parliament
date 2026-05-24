/**
 * Divergent-generation phase for brainstorm mode.
 *
 * Runs all authors in parallel (never sequential — sequential would let later
 * authors anchor on earlier output, defeating anti-convergence). Each author
 * gets one parse attempt, then one corrective retry on JSON failure. If retry
 * also fails, the raw text is surfaced as a single best-effort idea with
 * `unstructured: true` rather than crashing the whole run.
 *
 * `idea_id` is intentionally left as a temp local value here. The dedupe phase
 * (Section 5) owns final ID assignment as a stable hash of (title, one_liner).
 *
 * Spec: `openspec/changes/add-brainstorm-mode/tasks.md` Section 4.
 */

import type { BrainstormIdea, BrainstormLineup, BrainstormPhaseRecord } from './types.js';
import type { AdapterFactory } from './orchestrator.js';
import {
  divergentAuthorPrompt,
  DIVERGENT_RETRY_INSTRUCTION,
} from './prompts.js';

export interface RunDivergentGenerationInput {
  prompt: string;
  lineup: BrainstormLineup;
  ideasPerAuthor: number;
  factory: AdapterFactory;
}

export interface DivergentGenerationOutput {
  ideas: BrainstormIdea[];
  warnings: string[];
  phaseRecord: BrainstormPhaseRecord;
}

interface RawIdea {
  title?: unknown;
  one_liner?: unknown;
  dimensions?: unknown;
  rationale?: unknown;
}

function tryParseIdeas(raw: string): RawIdea[] | null {
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

function tryParse(text: string): RawIdea[] | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;
    if (!Array.isArray(obj['ideas'])) return null;
    return obj['ideas'] as RawIdea[];
  } catch {
    return null;
  }
}

function validateAndShapeIdeas(
  raw: RawIdea[],
  authorModel: string,
  authorIndex: number,
): BrainstormIdea[] | null {
  const out: BrainstormIdea[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (typeof entry !== 'object' || entry === null) return null;
    const e = entry as Record<string, unknown>;
    if (typeof e['title'] !== 'string' || (e['title'] as string).trim() === '') return null;
    if (typeof e['one_liner'] !== 'string' || (e['one_liner'] as string).trim() === '') return null;
    if (typeof e['dimensions'] !== 'object' || e['dimensions'] === null) return null;
    if (typeof e['rationale'] !== 'string' || (e['rationale'] as string).trim() === '') return null;

    const dims = e['dimensions'] as Record<string, unknown>;
    const dimensionValues: string[] = [];
    for (const key of ['problem', 'audience', 'mechanism']) {
      const v = dims[key];
      if (typeof v !== 'string' || (v as string).trim() === '') return null;
      dimensionValues.push((v as string).trim());
    }

    out.push({
      idea_id: `${authorModel}#${authorIndex}_${i}`,
      title: (e['title'] as string).trim(),
      one_liner: (e['one_liner'] as string).trim(),
      dimensions: dimensionValues,
      rationale: (e['rationale'] as string).trim(),
      author_model: authorModel,
    });
  }
  return out;
}

async function generateForAuthor(
  authorModel: string,
  authorIndex: number,
  prompt: string,
  ideasPerAuthor: number,
  factory: AdapterFactory,
): Promise<{ ideas: BrainstormIdea[]; warnings: string[] }> {
  const warnings: string[] = [];
  const adapter = factory(authorModel);
  const { system, user } = divergentAuthorPrompt({ prompt, ideasPerAuthor, authorModel });

  const result = await adapter.generate(user, system);
  let rawIdeas = tryParseIdeas(result.content);

  if (rawIdeas === null) {
    warnings.push(
      `divergent-generation: author ${authorModel} returned unparseable JSON; retrying.`,
    );
    const retryResult = await adapter.generate(
      `${DIVERGENT_RETRY_INSTRUCTION}\n\nOriginal prompt:\n${user}\n\nYour previous response:\n${result.content}`,
      system,
    );
    rawIdeas = tryParseIdeas(retryResult.content);

    if (rawIdeas === null) {
      warnings.push(
        `divergent-generation: author ${authorModel} still unparseable after retry; surfacing as unstructured.`,
      );
      return {
        ideas: [
          {
            idea_id: `${authorModel}#${authorIndex}_0`,
            title: '',
            one_liner: '',
            dimensions: [],
            rationale: retryResult.content,
            author_model: authorModel,
            unstructured: true,
          },
        ],
        warnings,
      };
    }
  }

  const shaped = validateAndShapeIdeas(rawIdeas, authorModel, authorIndex);
  if (shaped === null) {
    warnings.push(
      `divergent-generation: author ${authorModel} returned structurally invalid ideas; surfacing as unstructured.`,
    );
    return {
      ideas: [
        {
          idea_id: `${authorModel}#${authorIndex}_0`,
          title: '',
          one_liner: '',
          dimensions: [],
          rationale: result.content,
          author_model: authorModel,
          unstructured: true,
        },
      ],
      warnings,
    };
  }

  if (shaped.length !== ideasPerAuthor) {
    warnings.push(
      `divergent-generation: author ${authorModel} returned ${shaped.length} ideas, expected ${ideasPerAuthor}.`,
    );
  }

  return { ideas: shaped, warnings };
}

export async function runDivergentGeneration({
  prompt,
  lineup,
  ideasPerAuthor,
  factory,
}: RunDivergentGenerationInput): Promise<DivergentGenerationOutput> {
  const authorResults = await Promise.all(
    lineup.divergentAuthors.map((author, idx) =>
      generateForAuthor(author.model, idx, prompt, ideasPerAuthor, factory),
    ),
  );

  const allIdeas: BrainstormIdea[] = [];
  const allWarnings: string[] = [];
  for (const r of authorResults) {
    allIdeas.push(...r.ideas);
    allWarnings.push(...r.warnings);
  }

  const phaseRecord: BrainstormPhaseRecord = {
    phase: 'divergent-generation',
    ideas: allIdeas,
    warnings: allWarnings.length > 0 ? allWarnings : undefined,
  };

  return { ideas: allIdeas, warnings: allWarnings, phaseRecord };
}
