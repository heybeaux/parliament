/**
 * Enforces a word count cap on the given text.
 * Returns the (possibly truncated) content and a flag indicating truncation.
 */
export function enforceWordCap(
  text: string,
  cap = 100,
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
