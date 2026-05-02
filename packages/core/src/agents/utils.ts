import type { DeliberationSource } from '../types.js';

/**
 * Stable heading prepended to user-supplied context. Kept as a constant so
 * tests can pin the exact wire shape and the engine's prompt-builder doesn't
 * drift across agents.
 *
 * PAR-16 — see ticket description and
 * `packages/core/src/__tests__/context.test.ts` for the contract.
 */
export const CONTEXT_HEADING = '## Background';

/**
 * Stable heading for the structured-sources block (PAR-17). The block sits
 * AFTER the `## Background` context section (when both are present) and
 * BEFORE the topic / current debate state. Pinned as a constant so the
 * engine + agent prompt builders + the prompt-construction tests cannot
 * drift apart on the wire shape.
 */
export const SOURCES_HEADING = '## Sources';

/**
 * Default per-source word cap applied at prompt-construction time when no
 * explicit `maxSourceWords` is supplied on the deliberation config.
 *
 * 500 words is the deliberate balance:
 *   - long enough that a single small paper / memo / code-summary fits
 *     without the model losing the thread (most ~1-page docs sit under this);
 *   - short enough that 5-10 sources stay well within the 8-16k context
 *     window that small open-weight models handle reliably.
 *
 * Configurable per-run via `DeliberationConfig.maxSourceWords` (and the
 * topology variant) so tests can pin small caps and operators can override
 * from `parliament.toml`. PAR-17.
 */
export const DEFAULT_MAX_SOURCE_WORDS = 500;

/**
 * Trailing instruction appended to every non-Sentry agent's user prompt when
 * sources are present. Pinned as a constant so the engine, the Empiricist's
 * sources-aware mode, and the prompt-construction tests share a single line.
 *
 * The engine does NOT enforce citations — it just exposes the contract per
 * the ticket, leaving validation to downstream tooling.
 */
export const CITATION_INSTRUCTION =
  'When you reference a source above, cite it as `[id]` where id is the bracketed identifier shown.';

/**
 * Truncate `text` to a whitespace-delimited word cap, appending a stable
 * `... [truncated]` marker when the cap was hit. The marker is load-bearing:
 * the prompt-construction tests assert on it, and the UI Sources panel may
 * surface a "show more" affordance keyed off the same boundary.
 *
 * Empty / whitespace-only `text` returns the empty string. The cap MUST be
 * a positive integer — tests pass small values (e.g. 4) to exercise the
 * truncation branch; values <= 0 fall back to the input unchanged so a
 * caller misconfiguration can't silently swallow content.
 */
function truncateToWordCap(text: string, cap: number): string {
  if (cap <= 0) return text;
  const trimmed = text.trim();
  if (trimmed.length === 0) return '';
  // `text.split(/\s+/)` is the same primitive used by `enforceWordCap` and
  // the engine's word-count helper, so the cap math here is consistent
  // with everything else that counts words on a Turn.
  const words = trimmed.split(/\s+/);
  if (words.length <= cap) return trimmed;
  return `${words.slice(0, cap).join(' ')} ... [truncated]`;
}

/**
 * Format a list of `DeliberationSource` entries as the prompt's `## Sources`
 * block (PAR-17). The output is deterministic — sources render in the order
 * the user supplied them — and uses the stable `[id]` prefix per source so
 * agents can cite directly with the same bracketed identifier.
 *
 * Format (one block per source):
 *
 *   ## Sources
 *
 *   [paper-foo-2024] (paper) "Foo et al. 2024 — Title"
 *   <up-to-cap content>
 *
 *   [memo-internal] (memo) "Internal launch plan"
 *   <up-to-cap content>
 *
 *   ...
 *
 *   When you reference a source above, cite it as `[id]` where id is the
 *   bracketed identifier shown.
 *
 * The kind chip is omitted when the source has no `kind` declared. Per-source
 * content is truncated to `maxSourceWords` (default 500) using
 * whitespace-delimited word splitting; truncated content carries a trailing
 * `... [truncated]` marker so downstream consumers can detect it.
 *
 * Returns `null` when `sources` is undefined / empty so the caller can omit
 * the block entirely (no empty `## Sources` heading on the wire).
 */
export function buildSourcesBlock(
  sources: readonly DeliberationSource[] | undefined,
  maxSourceWords: number = DEFAULT_MAX_SOURCE_WORDS,
): string | null {
  if (sources === undefined || sources.length === 0) return null;

  const blocks = sources.map((src) => {
    const kindChip = src.kind !== undefined ? ` (${src.kind})` : '';
    const truncated = truncateToWordCap(src.content, maxSourceWords);
    // The header line uses `[id]` so the agent's citation primitive is
    // visually identical to the prefix it sees here — quote whichever id
    // appeared in the bracketed prefix and the tooling can match it.
    return `[${src.id}]${kindChip} "${src.title}"\n${truncated}`;
  });

  return `${SOURCES_HEADING}\n\n${blocks.join('\n\n')}\n\n${CITATION_INSTRUCTION}`;
}

/**
 * Builds the shared header prepended to every non-sentry agent's user prompt.
 *
 * The header tells the model:
 *   1. Today's date (so it doesn't hallucinate stale calendar context).
 *   2. The cast of participants (so it treats `[Skeptic]:`, `[RedAgent]:`,
 *      etc. as real co-deliberators rather than fictional voices it should
 *      "explain" or invent).
 *   3. The topic itself.
 *   4. Optional user-supplied context (PAR-16) — when present, the prose
 *      is prepended under a stable `## Background` heading so every agent
 *      sees the same brief at the very top of its user message.
 *   5. Optional structured sources (PAR-17) — when present, each source
 *      renders as a `[id] (kind) "title"\n<content>` block under a stable
 *      `## Sources` heading, BETWEEN the context and the base header. The
 *      block ends with the standing citation instruction so agents are
 *      uniformly told to cite by `[id]`.
 *
 * Sentry is intentionally excluded — it's a structural classifier whose
 * single job is to emit `ok | specialist_needed | collapse_detected` and
 * doesn't benefit from cast context.
 *
 * `context` is optional and the empty / whitespace-only case is treated as
 * absent so callers can pass `blackboard.context` directly without
 * pre-trimming. `sources` is optional and the empty / undefined case is
 * treated as absent so the prompt is byte-identical to the pre-PAR-17 shape
 * when no sources are supplied.
 */
export function buildPromptHeader(
  topic: string,
  context?: string,
  sources?: readonly DeliberationSource[],
  maxSourceWords: number = DEFAULT_MAX_SOURCE_WORDS,
): string {
  const today = new Date().toISOString().slice(0, 10);
  const baseHeader = [
    `Current date: ${today}.`,
    `This is a multi-agent deliberation. Other participants are named Proposer, Skeptic, Synthesizer, and RedAgent. References to them in the transcript are real participants, not fabrications.`,
    `Topic: ${topic}`,
  ].join('\n');

  const trimmedContext = context?.trim();
  const sourcesBlock = buildSourcesBlock(sources, maxSourceWords);

  const sections: string[] = [];
  if (trimmedContext !== undefined && trimmedContext.length > 0) {
    sections.push(`${CONTEXT_HEADING}\n\n${trimmedContext}`);
  }
  if (sourcesBlock !== null) {
    sections.push(sourcesBlock);
  }
  sections.push(baseHeader);

  // When neither context nor sources are present, this collapses to the
  // single `baseHeader` section — byte-identical to the pre-PAR-16 shape.
  // When either is present, sections are joined by the stable `\n\n---\n\n`
  // delimiter so every section boundary is visually distinct on the wire.
  return sections.join('\n\n---\n\n');
}

/**
 * Enforces a word count cap on the given text.
 * Returns the (possibly truncated) content and a flag indicating truncation.
 */
export function enforceWordCap(
  text: string,
  cap = 200,
): { content: string; truncated: boolean } {
  const words = text.trim().split(/\s+/);
  if (words.length <= cap) return { content: text.trim(), truncated: false };
  return { content: words.slice(0, cap).join(' '), truncated: true };
}

/**
 * Computes Jaccard similarity between two strings based on word overlap.
 * Returns a value in [0, 1].
 */
export function jaccardSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));

  if (wordsA.size === 0 && wordsB.size === 0) return 1;
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let intersectionSize = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) intersectionSize++;
  }

  const unionSize = wordsA.size + wordsB.size - intersectionSize;
  return intersectionSize / unionSize;
}
