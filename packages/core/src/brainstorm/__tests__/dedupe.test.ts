/**
 * Section 5.4 — idea-dedupe phase tests.
 *
 * Covers tasks 5.1–5.4 from `openspec/changes/add-brainstorm-mode/tasks.md`.
 *
 * Task 5.1 (cross-import of runDedupePhase into brainstorm) is confirmed by
 * the architectural lock test at no-ideate-coupling.test.ts (positive check
 * in task 12.2 will land there; this file covers behavioral correctness).
 */

import { describe, it, expect } from 'vitest';
import type { BrainstormIdea } from '../types.js';
import type { DedupeOptions } from '../../ideate/dedupe.js';
import { runIdeaDedupePhase, stableIdeaId } from '../dedupe.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIdea(
  overrides: Partial<BrainstormIdea> & { title: string; one_liner: string; author_model: string },
): BrainstormIdea {
  const { title, one_liner, author_model, dimensions, rationale, ...rest } = overrides;
  return {
    idea_id: `${author_model}#0_0`,
    title,
    one_liner,
    dimensions: dimensions ?? ['problem', 'audience', 'mechanism'],
    rationale: rationale ?? 'Some rationale.',
    author_model,
    ...rest,
  };
}

/** Embedder that returns embeddings from a preset map keyed by text. */
function makeEmbedder(
  embedMap: Record<string, number[]>,
): NonNullable<DedupeOptions['embedder']> {
  return async (_provider, texts) => {
    return texts.map((t) => {
      const vec = embedMap[t];
      if (vec === undefined) throw new Error(`Test embedder: no vector for "${t}"`);
      return vec;
    });
  };
}

/** Returns an embedder that always throws (simulates both providers failing). */
function failingEmbedder(): NonNullable<DedupeOptions['embedder']> {
  return async () => {
    throw new Error('embed provider down');
  };
}

// ---------------------------------------------------------------------------
// stableIdeaId
// ---------------------------------------------------------------------------

describe('stableIdeaId', () => {
  it('is deterministic', () => {
    const a = stableIdeaId('My Idea', 'A cool one-liner.');
    const b = stableIdeaId('My Idea', 'A cool one-liner.');
    expect(a).toBe(b);
  });

  it('differs for different titles', () => {
    const a = stableIdeaId('Idea A', 'Same one-liner.');
    const b = stableIdeaId('Idea B', 'Same one-liner.');
    expect(a).not.toBe(b);
  });

  it('differs for different one-liners', () => {
    const a = stableIdeaId('Same title', 'One liner A.');
    const b = stableIdeaId('Same title', 'One liner B.');
    expect(a).not.toBe(b);
  });

  it('is 16 hex characters', () => {
    const id = stableIdeaId('Test', 'Test one-liner.');
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });
});

// ---------------------------------------------------------------------------
// Empty input
// ---------------------------------------------------------------------------

describe('runIdeaDedupePhase — empty input', () => {
  it('returns empty ideas and phaseRecord when given zero ideas', async () => {
    const result = await runIdeaDedupePhase({ ideas: [] });
    expect(result.ideas).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
    expect(result.phaseRecord.phase).toBe('idea-dedupe');
    expect(result.phaseRecord.ideas).toHaveLength(0);
    expect(result.phaseRecord.dedupe?.skipped).toBe(false);
    expect(result.phaseRecord.dedupe?.merged_into).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// No duplicates — all ideas survive
// ---------------------------------------------------------------------------

describe('runIdeaDedupePhase — no duplicates', () => {
  it('all ideas survive when they are semantically distinct', async () => {
    const ideas = [
      makeIdea({ title: 'AI task manager', one_liner: 'Automate your to-do list.', author_model: 'model-a' }),
      makeIdea({ title: 'Crypto payments', one_liner: 'Pay anyone with stablecoins.', author_model: 'model-b' }),
      makeIdea({ title: 'AR navigation', one_liner: 'Navigate via augmented reality.', author_model: 'model-c' }),
    ];

    // Three unique orthogonal vectors → cosine = 0 for any pair → no collapse.
    const embedder = makeEmbedder({
      'title: AI task manager\none_liner: Automate your to-do list.': [1, 0, 0],
      'title: Crypto payments\none_liner: Pay anyone with stablecoins.': [0, 1, 0],
      'title: AR navigation\none_liner: Navigate via augmented reality.': [0, 0, 1],
    });

    const result = await runIdeaDedupePhase({ ideas, opts: { embedder, threshold: 0.85 } });

    expect(result.ideas).toHaveLength(3);
    expect(result.warnings).toHaveLength(0);
    expect(result.phaseRecord.dedupe?.merged_into).toEqual({});
    expect(result.phaseRecord.dedupe?.skipped).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cross-author duplicate collapses
// ---------------------------------------------------------------------------

describe('runIdeaDedupePhase — cross-author duplicate', () => {
  it('collapses ideas from different authors that are near-identical', async () => {
    const ideaA = makeIdea({
      title: 'Smart calendar',
      one_liner: 'AI-powered scheduling assistant.',
      author_model: 'model-a',
    });
    const ideaB = makeIdea({
      title: 'Smart calendar',
      one_liner: 'AI-powered scheduling assistant.',
      author_model: 'model-b',
      // Slightly longer rationale so model-b may win tiebreak.
      rationale: 'A much more detailed rationale that is longer than the other one so it wins.',
    });

    const sameVec = [1, 0, 0];
    const embedder = makeEmbedder({
      'title: Smart calendar\none_liner: AI-powered scheduling assistant.': sameVec,
    });

    const result = await runIdeaDedupePhase({ ideas: [ideaA, ideaB], opts: { embedder, threshold: 0.85 } });

    // One survivor — duplicates collapsed.
    expect(result.ideas).toHaveLength(1);
    // The surviving idea has a stable idea_id.
    const survivor = result.ideas[0]!;
    expect(survivor.idea_id).toBe(stableIdeaId('Smart calendar', 'AI-powered scheduling assistant.'));
    // Merge map records the collapse.
    expect(Object.keys(result.phaseRecord.dedupe!.merged_into)).toHaveLength(1);
    // Author identity preserved on survivor.
    expect(['model-a', 'model-b']).toContain(survivor.author_model);
  });

  it('merge map keys use author_model#index scheme (task 5.2)', async () => {
    const ideaA = makeIdea({ title: 'Same', one_liner: 'Same liner.', author_model: 'model-a' });
    const ideaB = makeIdea({ title: 'Same', one_liner: 'Same liner.', author_model: 'model-b' });

    const vec = [1, 0];
    const embedder = makeEmbedder({
      'title: Same\none_liner: Same liner.': vec,
    });

    const result = await runIdeaDedupePhase({ ideas: [ideaA, ideaB], opts: { embedder, threshold: 0.85 } });

    const mergeKeys = Object.keys(result.phaseRecord.dedupe!.merged_into);
    // Keys should contain model identifiers, not generic 'role#0' forms.
    expect(mergeKeys.length).toBeGreaterThan(0);
    for (const key of mergeKeys) {
      // Each key is in the form `<author_model>#<index>`.
      expect(key).toMatch(/^model-[ab]#\d+$/);
    }
    const mergeValues = Object.values(result.phaseRecord.dedupe!.merged_into);
    for (const val of mergeValues) {
      expect(val).toMatch(/^model-[ab]#\d+$/);
    }
  });
});

// ---------------------------------------------------------------------------
// Stable idea_id assignment
// ---------------------------------------------------------------------------

describe('runIdeaDedupePhase — stable idea_id', () => {
  it('assigns stable hash-based idea_id to surviving structured ideas', async () => {
    const idea = makeIdea({ title: 'Product A', one_liner: 'Does X.', author_model: 'model-a' });

    const embedder = makeEmbedder({
      'title: Product A\none_liner: Does X.': [1, 0],
    });

    const result = await runIdeaDedupePhase({ ideas: [idea], opts: { embedder } });

    expect(result.ideas[0]!.idea_id).toBe(stableIdeaId('Product A', 'Does X.'));
  });

  it('unstructured ideas keep their temp idea_id unchanged', async () => {
    const unstructured: BrainstormIdea = {
      idea_id: 'model-a#0_0',
      title: '',
      one_liner: '',
      dimensions: [],
      rationale: 'Here is my raw prose response.',
      author_model: 'model-a',
      unstructured: true,
    };

    const embedder = makeEmbedder({
      'Here is my raw prose response.': [1, 0],
    });

    const result = await runIdeaDedupePhase({ ideas: [unstructured], opts: { embedder } });

    expect(result.ideas[0]!.idea_id).toBe('model-a#0_0');
    expect(result.ideas[0]!.unstructured).toBe(true);
  });

  it('idea_id is stable across two runs with same inputs', async () => {
    const idea = makeIdea({ title: 'Rerun Test', one_liner: 'Stable across reruns.', author_model: 'model-a' });
    const embedder = makeEmbedder({
      'title: Rerun Test\none_liner: Stable across reruns.': [1, 0],
    });

    const r1 = await runIdeaDedupePhase({ ideas: [idea], opts: { embedder } });
    const r2 = await runIdeaDedupePhase({ ideas: [idea], opts: { embedder } });

    expect(r1.ideas[0]!.idea_id).toBe(r2.ideas[0]!.idea_id);
  });
});

// ---------------------------------------------------------------------------
// Phase record shape (task 5.3)
// ---------------------------------------------------------------------------

describe('runIdeaDedupePhase — phaseRecord', () => {
  it('phaseRecord.phase is idea-dedupe (not "dedupe")', async () => {
    const idea = makeIdea({ title: 'X', one_liner: 'Y.', author_model: 'model-a' });
    const embedder = makeEmbedder({ 'title: X\none_liner: Y.': [1] });

    const result = await runIdeaDedupePhase({ ideas: [idea], opts: { embedder } });

    expect(result.phaseRecord.phase).toBe('idea-dedupe');
  });

  it('phaseRecord carries surviving ideas', async () => {
    const ideas = [
      makeIdea({ title: 'A', one_liner: 'A liner.', author_model: 'model-a' }),
      makeIdea({ title: 'B', one_liner: 'B liner.', author_model: 'model-b' }),
    ];
    const embedder = makeEmbedder({
      'title: A\none_liner: A liner.': [1, 0],
      'title: B\none_liner: B liner.': [0, 1],
    });

    const result = await runIdeaDedupePhase({ ideas, opts: { embedder } });

    expect(result.phaseRecord.ideas).toHaveLength(2);
  });

  it('phaseRecord.dedupe.provider reflects embedder source', async () => {
    const idea = makeIdea({ title: 'X', one_liner: 'Y.', author_model: 'model-a' });
    const embedder = makeEmbedder({ 'title: X\none_liner: Y.': [1] });

    const result = await runIdeaDedupePhase({
      ideas: [idea],
      opts: { embedder, providerOrder: ['local', 'cloud'] },
    });

    expect(['local', 'cloud', null]).toContain(result.phaseRecord.dedupe?.provider);
  });
});

// ---------------------------------------------------------------------------
// Soft-fail behavior — task 5.4
// ---------------------------------------------------------------------------

describe('runIdeaDedupePhase — soft-fail', () => {
  it('skips dedupe and returns all ideas when embedder fails', async () => {
    const ideas = [
      makeIdea({ title: 'Alpha', one_liner: 'Alpha liner.', author_model: 'model-a' }),
      makeIdea({ title: 'Beta', one_liner: 'Beta liner.', author_model: 'model-b' }),
    ];

    const result = await runIdeaDedupePhase({
      ideas,
      opts: { embedder: failingEmbedder(), providerOrder: ['local'] },
    });

    // All ideas survive (dedupe skipped).
    expect(result.ideas).toHaveLength(2);
    // Warning is surfaced.
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toMatch(/dedupe skipped/);
    // Phase record shows skipped.
    expect(result.phaseRecord.dedupe?.skipped).toBe(true);
    expect(result.phaseRecord.warnings).toBeDefined();
  });

  it('skipped soft-fail ideas still get stable idea_ids', async () => {
    const idea = makeIdea({ title: 'Persist Me', one_liner: 'Even on skip.', author_model: 'model-a' });

    const result = await runIdeaDedupePhase({
      ideas: [idea],
      opts: { embedder: failingEmbedder(), providerOrder: ['local'] },
    });

    // Even on skip, stable idea_id should be assigned.
    expect(result.ideas[0]!.idea_id).toBe(stableIdeaId('Persist Me', 'Even on skip.'));
  });
});

// ---------------------------------------------------------------------------
// Author identity preserved on survivor
// ---------------------------------------------------------------------------

describe('runIdeaDedupePhase — author identity', () => {
  it('author_model is preserved on all surviving ideas', async () => {
    const ideas = [
      makeIdea({ title: 'Unique A', one_liner: 'Liner A.', author_model: 'opus-4-6' }),
      makeIdea({ title: 'Unique B', one_liner: 'Liner B.', author_model: 'gemini-2-5-pro' }),
      makeIdea({ title: 'Unique C', one_liner: 'Liner C.', author_model: 'gpt-5' }),
    ];

    const embedder = makeEmbedder({
      'title: Unique A\none_liner: Liner A.': [1, 0, 0],
      'title: Unique B\none_liner: Liner B.': [0, 1, 0],
      'title: Unique C\none_liner: Liner C.': [0, 0, 1],
    });

    const result = await runIdeaDedupePhase({ ideas, opts: { embedder } });

    expect(result.ideas).toHaveLength(3);
    const authors = result.ideas.map((i) => i.author_model);
    expect(authors).toContain('opus-4-6');
    expect(authors).toContain('gemini-2-5-pro');
    expect(authors).toContain('gpt-5');
  });

  it('surviving idea retains author_model after collapse', async () => {
    const ideaA = makeIdea({ title: 'Dupe', one_liner: 'Same.', author_model: 'model-a' });
    const ideaB = makeIdea({ title: 'Dupe', one_liner: 'Same.', author_model: 'model-b' });

    const embedder = makeEmbedder({
      'title: Dupe\none_liner: Same.': [1, 0],
    });

    const result = await runIdeaDedupePhase({ ideas: [ideaA, ideaB], opts: { embedder } });

    expect(result.ideas).toHaveLength(1);
    const survivor = result.ideas[0]!;
    expect(typeof survivor.author_model).toBe('string');
    expect(survivor.author_model.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Single idea — no work needed
// ---------------------------------------------------------------------------

describe('runIdeaDedupePhase — single idea', () => {
  it('single idea passes through with stable idea_id', async () => {
    const idea = makeIdea({ title: 'Solo Idea', one_liner: 'Just one.', author_model: 'model-solo' });

    const result = await runIdeaDedupePhase({ ideas: [idea] });

    expect(result.ideas).toHaveLength(1);
    expect(result.ideas[0]!.idea_id).toBe(stableIdeaId('Solo Idea', 'Just one.'));
    expect(result.phaseRecord.dedupe?.merged_into).toEqual({});
    expect(result.phaseRecord.dedupe?.skipped).toBe(false);
  });
});
