/**
 * Builds the shared header prepended to every non-sentry agent's user prompt.
 *
 * The header tells the model:
 *   1. Today's date (so it doesn't hallucinate stale calendar context).
 *   2. The cast of participants (so it treats `[Skeptic]:`, `[RedAgent]:`,
 *      etc. as real co-deliberators rather than fictional voices it should
 *      "explain" or invent).
 *   3. The topic itself.
 *
 * Sentry is intentionally excluded — it's a structural classifier whose
 * single job is to emit `ok | specialist_needed | collapse_detected` and
 * doesn't benefit from cast context.
 */
export function buildPromptHeader(topic: string): string {
  const today = new Date().toISOString().slice(0, 10);
  return [
    `Current date: ${today}.`,
    `This is a multi-agent deliberation. Other participants are named Proposer, Skeptic, Synthesizer, and RedAgent. References to them in the transcript are real participants, not fabrications.`,
    `Topic: ${topic}`,
  ].join('\n');
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
