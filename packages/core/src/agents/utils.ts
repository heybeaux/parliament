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
 *
 * Sentry is intentionally excluded — it's a structural classifier whose
 * single job is to emit `ok | specialist_needed | collapse_detected` and
 * doesn't benefit from cast context.
 *
 * `context` is optional and the empty / whitespace-only case is treated as
 * absent so callers can pass `blackboard.context` directly without
 * pre-trimming.
 */
export function buildPromptHeader(topic: string, context?: string): string {
  const today = new Date().toISOString().slice(0, 10);
  const baseHeader = [
    `Current date: ${today}.`,
    `This is a multi-agent deliberation. Other participants are named Proposer, Skeptic, Synthesizer, and RedAgent. References to them in the transcript are real participants, not fabrications.`,
    `Topic: ${topic}`,
  ].join('\n');

  const trimmedContext = context?.trim();
  if (trimmedContext === undefined || trimmedContext.length === 0) {
    return baseHeader;
  }

  // Stable heading + delimiter pin the contract documented on the ticket
  // and exercised by the engine context test.
  return `${CONTEXT_HEADING}\n\n${trimmedContext}\n\n---\n\n${baseHeader}`;
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
