import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DEDUPE_THRESHOLD,
  cosineSimilarity,
  runDedupePhase,
  type DedupeEmbedder,
  type DedupeProviderId,
} from '../dedupe.js';
import type { PhaseContribution } from '../types.js';

/**
 * Build a PhaseContribution with sensible defaults. Tests only care about
 * `role` (for synthetic ID generation) and `content` (for tiebreak length).
 */
function draft(role: string, content: string): PhaseContribution {
  return {
    role: role as PhaseContribution['role'],
    model: 'test-model',
    content,
    timestamp: '2026-05-23T00:00:00.000Z',
  };
}

/**
 * Stub embedder factory. Returns a closure honoring a per-provider behavior
 * map. Behavior is either a list of vectors or an Error to throw.
 */
function stubEmbedder(
  behavior: Partial<Record<DedupeProviderId, number[][] | Error>>,
): DedupeEmbedder {
  return async (provider, texts) => {
    const b = behavior[provider];
    if (b instanceof Error) throw b;
    if (b === undefined) throw new Error(`stub: no behavior for ${provider}`);
    // Defensive: if the test sized the stub wrong vs the inputs, surface it.
    if (b.length !== texts.length) {
      throw new Error(
        `stub: behavior length ${b.length} != texts length ${texts.length} for ${provider}`,
      );
    }
    return b;
  };
}

describe('runDedupePhase', () => {
  it('both providers succeed → uses local (first in order), no warning', async () => {
    const drafts = [draft('innovator', 'aaa'), draft('skeptic', 'bbb')];
    // Identical-direction vectors → cosine = 1.0 → collapse.
    const localVecs = [
      [1, 0, 0],
      [1, 0, 0],
    ];
    const cloudVecs = [
      [0, 1, 0],
      [1, 0, 0],
    ];
    const result = await runDedupePhase(drafts, {
      embedder: stubEmbedder({ local: localVecs, cloud: cloudVecs }),
    });
    expect(result.provider).toBe('local');
    expect(result.skipped).toBe(false);
    expect(result.warning).toBeUndefined();
    // Equal-length contents → stable tiebreak picks index 0 (innovator).
    expect(result.kept).toHaveLength(1);
    expect(result.kept[0]?.role).toBe('innovator');
    expect(result.merged_into).toEqual({ 'skeptic#1': 'innovator#0' });
  });

  it('local fails → cloud succeeds, provider=cloud, no warning', async () => {
    const drafts = [draft('innovator', 'aaa'), draft('skeptic', 'bbb')];
    const result = await runDedupePhase(drafts, {
      embedder: stubEmbedder({
        local: new Error('connection refused'),
        cloud: [
          [1, 0],
          [0, 1],
        ],
      }),
    });
    expect(result.provider).toBe('cloud');
    expect(result.skipped).toBe(false);
    expect(result.warning).toBeUndefined();
    // Orthogonal vectors → no collapse.
    expect(result.kept).toHaveLength(2);
    expect(result.merged_into).toEqual({});
  });

  it('both providers fail → skip with warning, drafts pass through untouched', async () => {
    const drafts = [draft('innovator', 'aaa'), draft('skeptic', 'bbb')];
    const result = await runDedupePhase(drafts, {
      embedder: stubEmbedder({
        local: new Error('local down'),
        cloud: new Error('cloud 503'),
      }),
    });
    expect(result.skipped).toBe(true);
    expect(result.provider).toBeNull();
    expect(result.warning).toBeDefined();
    expect(result.warning).toContain('local down');
    expect(result.warning).toContain('cloud 503');
    expect(result.kept).toEqual(drafts);
    expect(result.merged_into).toEqual({});
  });

  it('threshold edge: 0.0 → everything collapses to a single survivor', async () => {
    const drafts = [
      draft('innovator', 'aaa'),
      draft('skeptic', 'bbb'),
      draft('contrarian', 'cccc'),
    ];
    // Even orthogonal pairs (cos=0) collapse when threshold is 0.
    const result = await runDedupePhase(drafts, {
      threshold: 0,
      embedder: stubEmbedder({
        local: [
          [1, 0, 0],
          [0, 1, 0],
          [0, 0, 1],
        ],
      }),
    });
    expect(result.skipped).toBe(false);
    // 'cccc' is longest → wins the tiebreak chain.
    expect(result.kept).toHaveLength(1);
    expect(result.kept[0]?.role).toBe('contrarian');
  });

  it('threshold edge: 1.0 → only exact-match cosine=1.0 pairs collapse', async () => {
    const drafts = [
      draft('innovator', 'aaa'),
      draft('skeptic', 'bbb'),
      draft('contrarian', 'cccc'),
    ];
    // Pair (0,1) cosine = 1.0 exactly; pair (0,2) ~0.97; pair (1,2) ~0.97.
    // Only the exact match should collapse.
    const result = await runDedupePhase(drafts, {
      threshold: 1.0,
      embedder: stubEmbedder({
        local: [
          [1, 0],
          [1, 0],
          [0.95, 0.05],
        ],
      }),
    });
    expect(result.skipped).toBe(false);
    // innovator/skeptic collapse → 2 survivors (innovator + contrarian).
    expect(result.kept).toHaveLength(2);
    expect(result.kept.map((c) => c.role).sort()).toEqual(['contrarian', 'innovator']);
  });

  it('tiebreak on equal cosine: longer content wins', async () => {
    const drafts = [
      draft('innovator', 'short'),
      draft('skeptic', 'much longer draft content here'),
    ];
    const result = await runDedupePhase(drafts, {
      embedder: stubEmbedder({
        local: [
          [1, 0],
          [1, 0],
        ],
      }),
    });
    expect(result.kept).toHaveLength(1);
    expect(result.kept[0]?.role).toBe('skeptic');
    expect(result.merged_into).toEqual({ 'innovator#0': 'skeptic#1' });
  });

  it('transitive collapse: A~B and B~C → all collapse into one survivor', async () => {
    const drafts = [
      draft('innovator', 'a'),
      draft('skeptic', 'bb'),
      draft('contrarian', 'ccc'),
    ];
    // All three nearly-identical: pairwise cosine all = 1.0 → transitive collapse.
    const result = await runDedupePhase(drafts, {
      embedder: stubEmbedder({
        local: [
          [1, 0],
          [1, 0],
          [1, 0],
        ],
      }),
    });
    expect(result.skipped).toBe(false);
    // 'ccc' is longest → root survivor.
    expect(result.kept).toHaveLength(1);
    expect(result.kept[0]?.role).toBe('contrarian');
    // Both other drafts mapped to contrarian survivor (directly or via transitive walk).
    expect(result.merged_into['innovator#0']).toBe('contrarian#2');
    expect(result.merged_into['skeptic#1']).toBe('contrarian#2');
  });

  it('≤1 draft passthrough: 0 drafts → empty result, no provider call', async () => {
    const result = await runDedupePhase([], {
      embedder: stubEmbedder({ local: new Error('should not be called') }),
    });
    expect(result.kept).toEqual([]);
    expect(result.provider).toBeNull();
    expect(result.skipped).toBe(false);
    expect(result.threshold).toBe(DEFAULT_DEDUPE_THRESHOLD);
  });

  it('≤1 draft passthrough: 1 draft → returned as-is, no provider call', async () => {
    const drafts = [draft('innovator', 'aaa')];
    const result = await runDedupePhase(drafts, {
      embedder: stubEmbedder({ local: new Error('should not be called') }),
    });
    expect(result.kept).toEqual(drafts);
    expect(result.provider).toBeNull();
    expect(result.skipped).toBe(false);
  });

  it('provider order respected: ["cloud","local"] tries cloud first', async () => {
    const drafts = [draft('innovator', 'aaa'), draft('skeptic', 'bbb')];
    const result = await runDedupePhase(drafts, {
      providerOrder: ['cloud', 'local'],
      embedder: stubEmbedder({
        cloud: [
          [1, 0],
          [0, 1],
        ],
        local: new Error('should not be called'),
      }),
    });
    expect(result.provider).toBe('cloud');
  });

  it('provider returns wrong-length embeddings → soft-fail skip with warning', async () => {
    const drafts = [draft('innovator', 'aaa'), draft('skeptic', 'bbb')];
    const result = await runDedupePhase(drafts, {
      embedder: async () => [[1, 0]], // 1 vector for 2 drafts — but stubEmbedder defends; use raw fn.
    });
    expect(result.skipped).toBe(true);
    expect(result.provider).toBeNull();
    expect(result.warning).toMatch(/1 embeddings for 2 drafts/);
    expect(result.kept).toEqual(drafts);
  });

  it('cosineSimilarity: parallel vectors = 1, orthogonal = 0, antiparallel = -1', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1.0);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1.0);
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});
