/**
 * Idea-level dedupe phase for the ideate orchestrator.
 *
 * Runs between `cooperative-build` and `adversarial-critique`. Embeds each
 * cooperative draft, computes pairwise cosine similarity, and collapses any
 * pair at-or-above `threshold` into a single survivor (higher confidence
 * wins; longer draft is the tiebreak). Soft-fails: if both embedding
 * providers error, the phase is skipped with a `phase.warning` and the
 * ideation continues with un-deduped drafts.
 *
 * Architectural lock (Pax): this module embeds + dedupes COOPERATIVE DRAFTS
 * only. It is NEVER to be called on critique problems. See
 * `assertCritiquesNotDeduped` in `./index.ts`. The multi-model perspective
 * signal that adversarial critiques produce is the whole reason ideate
 * exists; deduping critiques would silently erase it.
 *
 * Spec source: `openspec/changes/refine-ideate-forge/specs/ideate-mode/spec.md`.
 */

import type { PhaseContribution } from './types.js';

/** Default cosine threshold for collapsing two drafts. */
export const DEFAULT_DEDUPE_THRESHOLD = 0.85;

/** Default provider attempt order. Local first (free, fast); cloud as fallback. */
export const DEFAULT_PROVIDER_ORDER: readonly DedupeProviderId[] = ['local', 'cloud'];

/** Local engram-embed endpoint. */
export const LOCAL_EMBED_URL = 'http://localhost:8080';
/** Cloud Engram embed endpoint. */
export const CLOUD_EMBED_URL = 'https://api.openengram.ai';

export type DedupeProviderId = 'local' | 'cloud';

export interface DedupeOptions {
  /** Collapse pairs at-or-above this cosine similarity. Default `0.85`. */
  threshold?: number;
  /** Provider attempt order. Default `['local', 'cloud']`. */
  providerOrder?: readonly DedupeProviderId[];
  /**
   * Embedding fetcher seam — production code uses the built-in HTTP
   * implementation; tests inject a stub.
   *
   * Returns embeddings (one per input draft) for a given provider. Throws on
   * failure; the orchestrator catches and falls through to the next provider.
   */
  embedder?: DedupeEmbedder;
}

export type DedupeEmbedder = (
  provider: DedupeProviderId,
  texts: readonly string[],
) => Promise<number[][]>;

/**
 * One entry in the dedupe phase output. `kept` is the survivors that
 * proceed to adversarial-critique. `merged_into` maps a collapsed draft's
 * synthetic ID to the survivor's synthetic ID.
 */
export interface DedupeResult {
  kept: PhaseContribution[];
  /** Maps `merged-id -> survivor-id`. Synthetic IDs are role-keyed (see below). */
  merged_into: Record<string, string>;
  /** Provider that produced the embeddings (`local` or `cloud`). */
  provider: DedupeProviderId | null;
  /** True when both providers failed and the phase was skipped. */
  skipped: boolean;
  /** Threshold used for this run. */
  threshold: number;
  /** Set when `skipped === true` — error message(s) from provider attempts. */
  warning?: string;
}

/**
 * Run idea-level dedupe over a set of cooperative drafts. Returns survivors
 * + merge map + provider used + skip status. Never throws — provider
 * outages return `{ skipped: true, warning, kept: drafts unchanged }`.
 */
export async function runDedupePhase(
  drafts: readonly PhaseContribution[],
  opts: DedupeOptions = {},
): Promise<DedupeResult> {
  const threshold = opts.threshold ?? DEFAULT_DEDUPE_THRESHOLD;
  const providerOrder = opts.providerOrder ?? DEFAULT_PROVIDER_ORDER;
  const embed = opts.embedder ?? defaultEmbedder;

  // 0 or 1 drafts → no work to do. Preserve order.
  if (drafts.length <= 1) {
    return {
      kept: drafts.slice(),
      merged_into: {},
      provider: null,
      skipped: false,
      threshold,
    };
  }

  const texts = drafts.map((d) => d.content);
  let embeddings: number[][] | null = null;
  let providerUsed: DedupeProviderId | null = null;
  const errors: string[] = [];

  for (const provider of providerOrder) {
    try {
      embeddings = await embed(provider, texts);
      providerUsed = provider;
      break;
    } catch (err) {
      errors.push(`${provider}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (embeddings === null || providerUsed === null) {
    return {
      kept: drafts.slice(),
      merged_into: {},
      provider: null,
      skipped: true,
      threshold,
      warning: `dedupe skipped: all providers failed (${errors.join('; ')})`,
    };
  }

  // Validate the shape — defensive. If a provider returned the wrong
  // number of vectors, soft-fail rather than mis-collapse.
  if (embeddings.length !== drafts.length) {
    return {
      kept: drafts.slice(),
      merged_into: {},
      provider: null,
      skipped: true,
      threshold,
      warning: `dedupe skipped: provider ${providerUsed} returned ${embeddings.length} embeddings for ${drafts.length} drafts`,
    };
  }

  // Pairwise cosine, collapse into survivors. Iterate by index so we can
  // produce stable synthetic IDs (`<role>#<index>`) for the merge map.
  const ids = drafts.map((d, i) => `${d.role}#${i}`);
  const survivorIndex = new Map<number, number>(); // index -> survivor index (transitive)
  for (let i = 0; i < drafts.length; i++) survivorIndex.set(i, i);

  for (let i = 0; i < drafts.length; i++) {
    for (let j = i + 1; j < drafts.length; j++) {
      const cos = cosineSimilarity(embeddings[i]!, embeddings[j]!);
      if (cos >= threshold) {
        const survivor = chooseSurvivor(drafts, i, j);
        const loser = survivor === i ? j : i;
        // Re-point loser → survivor, accounting for transitive collapses.
        const rootOf = (k: number): number => {
          let cur = k;
          // Walk to the root survivor — bounded since we only point
          // forward in the collapse sequence.
          while (survivorIndex.get(cur)! !== cur) cur = survivorIndex.get(cur)!;
          return cur;
        };
        const survRoot = rootOf(survivor);
        const loserRoot = rootOf(loser);
        if (survRoot !== loserRoot) {
          survivorIndex.set(loserRoot, survRoot);
        }
      }
    }
  }

  const kept: PhaseContribution[] = [];
  const merged_into: Record<string, string> = {};
  for (let i = 0; i < drafts.length; i++) {
    let root = i;
    while (survivorIndex.get(root)! !== root) root = survivorIndex.get(root)!;
    if (root === i) {
      kept.push(drafts[i]!);
    } else {
      merged_into[ids[i]!] = ids[root]!;
    }
  }

  return {
    kept,
    merged_into,
    provider: providerUsed,
    skipped: false,
    threshold,
  };
}

/**
 * Pick the surviving draft when two collapse. Higher author confidence
 * wins; on equal confidence (or no confidence signal at all), the longer
 * content wins; final tiebreak is the earlier index (stable order).
 *
 * Confidence isn't yet a first-class field on PhaseContribution — fall
 * back to content length only. When confidence lands, we'll read it here.
 */
function chooseSurvivor(
  drafts: readonly PhaseContribution[],
  i: number,
  j: number,
): number {
  const a = drafts[i]!;
  const b = drafts[j]!;
  if (a.content.length > b.content.length) return i;
  if (b.content.length > a.content.length) return j;
  return i; // stable: earlier wins
}

/** Cosine similarity for two equal-length vectors. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Default embedder. Talks to local engram-embed or Engram Cloud via a
 * minimal POST request. Implementations of either service may evolve;
 * the shape here matches the documented `/embed` contract: POST
 * `{ texts: string[] }`, response `{ embeddings: number[][] }`.
 *
 * Tests override via `opts.embedder` so this code path is not exercised
 * in unit tests — it's a thin HTTP wrapper.
 */
const defaultEmbedder: DedupeEmbedder = async (provider, texts) => {
  const base = provider === 'local' ? LOCAL_EMBED_URL : CLOUD_EMBED_URL;
  const url = `${base}/embed`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ texts }),
  });
  if (!res.ok) {
    throw new Error(`${provider} embed HTTP ${res.status}`);
  }
  const body = (await res.json()) as { embeddings?: unknown };
  if (!Array.isArray(body.embeddings)) {
    throw new Error(`${provider} embed response missing embeddings[]`);
  }
  const out: number[][] = [];
  for (const row of body.embeddings) {
    if (!Array.isArray(row)) throw new Error(`${provider} embed row not array`);
    out.push(row.map((n) => Number(n)));
  }
  return out;
};

/**
 * Architectural lock: this function MUST be called by tests in the ideate
 * critique pipeline to assert that no cosine-collapse/dedupe utility is
 * invoked on critique problems. The function is intentionally trivial —
 * its value is the test coverage forcing future refactors to confront the
 * lock and Pax's "never dedupe critiques" rule.
 *
 * Lock source: `openspec/changes/refine-ideate-forge` design.md decision
 * "Critique-dedupe lock is architectural, not policy".
 */
export function assertCritiquesNotDeduped(): void {
  // No-op. The presence of this export, plus the call in tests covering
  // adversarial flow, makes the lock visible to anyone refactoring.
}
