/**
 * Section 8 — forge elaboration tests.
 *
 * Covers tasks 8.1–8.5 from `openspec/changes/add-brainstorm-mode/tasks.md`.
 *
 * What's exercised:
 *   - elaborateIdea happy-path shape (8.1, 8.3)
 *   - forgeTopK runs in parallel over top-K only (8.2)
 *   - forgeTopK preserves ranked order
 *   - one elaboration failure does not abort others; failed entry has
 *     elaboration=null + error populated (8.5 best-effort)
 *   - forge is gated by k (and by mode at the orchestrator level — represented
 *     here as "k=0 is a no-op", since forge.ts itself doesn't see `mode`)
 *   - final_score === null ideas are excluded from top-K (design.md §130)
 */
import { describe, it, expect } from 'vitest';
import type { ModelAdapter, AdapterResult } from '../../adapters/base.js';
import type { AdapterFactory } from '../orchestrator.js';
import type { BrainstormRankedIdea } from '../types.js';
import { elaborateIdea, forgeTopK } from '../forge.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRanked(
  overrides: Partial<BrainstormRankedIdea> & { idea_id: string; final_score: number | null; rank: number | null },
): BrainstormRankedIdea {
  const {
    idea_id,
    final_score,
    rank,
    title,
    one_liner,
    dimensions,
    rationale,
    cluster,
    criteria_scores,
    judges_attempted,
    judges_skipped,
    judge_skipped,
  } = overrides;
  return {
    idea_id,
    title: title ?? `Title ${idea_id}`,
    one_liner: one_liner ?? `One-liner for ${idea_id}.`,
    dimensions: dimensions ?? ['prob', 'aud', 'mech'],
    rationale: rationale ?? `Rationale for ${idea_id}.`,
    cluster: cluster ?? null,
    final_score,
    criteria_scores:
      criteria_scores ?? { novelty: 5, feasibility: 5, fit: 5, evidence: 5 },
    judges_attempted: judges_attempted ?? ['j1'],
    judges_skipped: judges_skipped ?? [],
    rank,
    judge_skipped: judge_skipped ?? false,
  };
}

/** Adapter factory that returns a canned string for every model. */
function staticFactory(response: string): AdapterFactory {
  return (model: string): ModelAdapter => ({
    modelName: model,
    async generate(_p: string, _s?: string): Promise<AdapterResult> {
      return { content: response };
    },
  });
}

/** Adapter factory whose generate always throws. */
function throwingFactory(message: string): AdapterFactory {
  return (model: string): ModelAdapter => ({
    modelName: model,
    async generate(): Promise<AdapterResult> {
      throw new Error(message);
    },
  });
}

/**
 * Counting factory: records a generate call against `counter`, optionally
 * delays, and returns a per-idea response. The delay lets us assert that
 * elaborations run in parallel (sum-of-delays would be ~3x; parallel ~1x).
 */
function countingFactory(opts: {
  counter: { calls: number; maxConcurrent: number; inflight: number };
  delayMs: number;
  response: (call: number) => string;
  shouldThrowOnCall?: (call: number) => string | undefined;
}): AdapterFactory {
  return (model: string): ModelAdapter => ({
    modelName: model,
    async generate(): Promise<AdapterResult> {
      const callIdx = opts.counter.calls;
      opts.counter.calls++;
      opts.counter.inflight++;
      if (opts.counter.inflight > opts.counter.maxConcurrent) {
        opts.counter.maxConcurrent = opts.counter.inflight;
      }
      try {
        await new Promise((r) => setTimeout(r, opts.delayMs));
        const maybeThrow = opts.shouldThrowOnCall?.(callIdx);
        if (maybeThrow !== undefined) {
          throw new Error(maybeThrow);
        }
        return { content: opts.response(callIdx) };
      } finally {
        opts.counter.inflight--;
      }
    },
  });
}

// ---------------------------------------------------------------------------
// 8.1 / 8.3 — elaborateIdea shape
// ---------------------------------------------------------------------------

describe('elaborateIdea — happy path shape', () => {
  it('returns ForgeElaboration with idea_id, elaboration, model, timestamp', async () => {
    const idea = makeRanked({ idea_id: 'aaa', final_score: 7.5, rank: 1 });
    const result = await elaborateIdea(idea, 'brainstorm prompt', 'opus-model', staticFactory('Project sketch text.'));

    expect(result.idea_id).toBe('aaa');
    expect(result.elaboration).toBe('Project sketch text.');
    expect(result.model).toBe('opus-model');
    expect(typeof result.timestamp).toBe('string');
    // ISO 8601 sanity
    expect(Number.isNaN(Date.parse(result.timestamp))).toBe(false);
    expect(result.error).toBeUndefined();
  });

  it('trims surrounding whitespace from the elaboration', async () => {
    const idea = makeRanked({ idea_id: 'a', final_score: 5, rank: 1 });
    const result = await elaborateIdea(idea, 'p', 'm', staticFactory('   \n\nElaboration body.\n\n  '));
    expect(result.elaboration).toBe('Elaboration body.');
  });

  it('returns elaboration=null + error when adapter throws', async () => {
    const idea = makeRanked({ idea_id: 'a', final_score: 5, rank: 1 });
    const result = await elaborateIdea(idea, 'p', 'm', throwingFactory('model offline'));
    expect(result.idea_id).toBe('a');
    expect(result.elaboration).toBeNull();
    expect(result.model).toBe('m');
    expect(result.error).toMatch(/model offline/);
  });

  it('returns elaboration=null + error on empty response', async () => {
    const idea = makeRanked({ idea_id: 'a', final_score: 5, rank: 1 });
    const result = await elaborateIdea(idea, 'p', 'm', staticFactory('   \n  '));
    expect(result.elaboration).toBeNull();
    expect(result.error).toMatch(/empty response/);
  });
});

// ---------------------------------------------------------------------------
// 8.2 — forgeTopK runs in parallel over top-K only
// ---------------------------------------------------------------------------

describe('forgeTopK — parallelism and top-K slicing', () => {
  it('elaborates exactly k ideas (k < ranked.length)', async () => {
    const ranked: BrainstormRankedIdea[] = [
      makeRanked({ idea_id: 'r1', final_score: 9, rank: 1 }),
      makeRanked({ idea_id: 'r2', final_score: 8, rank: 2 }),
      makeRanked({ idea_id: 'r3', final_score: 7, rank: 3 }),
      makeRanked({ idea_id: 'r4', final_score: 6, rank: 4 }),
      makeRanked({ idea_id: 'r5', final_score: 5, rank: 5 }),
    ];
    const counter = { calls: 0, maxConcurrent: 0, inflight: 0 };
    const factory = countingFactory({
      counter,
      delayMs: 0,
      response: (i) => `sketch-${i}`,
    });

    const out = await forgeTopK(ranked, 'p', 3, 'opus', factory);
    expect(out).toHaveLength(3);
    expect(out.map((e) => e.idea_id)).toEqual(['r1', 'r2', 'r3']);
    expect(counter.calls).toBe(3);
  });

  it('preserves ranked order in the output', async () => {
    const ranked: BrainstormRankedIdea[] = [
      makeRanked({ idea_id: 'first', final_score: 9, rank: 1 }),
      makeRanked({ idea_id: 'second', final_score: 8, rank: 2 }),
      makeRanked({ idea_id: 'third', final_score: 7, rank: 3 }),
    ];
    const out = await forgeTopK(ranked, 'p', 3, 'opus', staticFactory('x'));
    expect(out.map((e) => e.idea_id)).toEqual(['first', 'second', 'third']);
  });

  it('runs elaborations in parallel (concurrent > 1 with delayed adapter)', async () => {
    const ranked: BrainstormRankedIdea[] = [
      makeRanked({ idea_id: 'a', final_score: 9, rank: 1 }),
      makeRanked({ idea_id: 'b', final_score: 8, rank: 2 }),
      makeRanked({ idea_id: 'c', final_score: 7, rank: 3 }),
    ];
    const counter = { calls: 0, maxConcurrent: 0, inflight: 0 };
    const factory = countingFactory({
      counter,
      delayMs: 20,
      response: () => 'sketch',
    });

    const start = Date.now();
    await forgeTopK(ranked, 'p', 3, 'opus', factory);
    const elapsed = Date.now() - start;

    // All three should overlap → maxConcurrent should be 3. Sequential would
    // be ~60ms; parallel ~20-30ms. Allow generous wall-clock slack.
    expect(counter.maxConcurrent).toBe(3);
    expect(elapsed).toBeLessThan(60);
  });

  it('elaborates all ranked when k >= ranked.length', async () => {
    const ranked: BrainstormRankedIdea[] = [
      makeRanked({ idea_id: 'a', final_score: 9, rank: 1 }),
      makeRanked({ idea_id: 'b', final_score: 8, rank: 2 }),
    ];
    const out = await forgeTopK(ranked, 'p', 10, 'opus', staticFactory('x'));
    expect(out).toHaveLength(2);
  });

  it('returns [] when k <= 0 and never calls the adapter', async () => {
    const ranked: BrainstormRankedIdea[] = [
      makeRanked({ idea_id: 'a', final_score: 9, rank: 1 }),
    ];
    const counter = { calls: 0, maxConcurrent: 0, inflight: 0 };
    const factory = countingFactory({
      counter,
      delayMs: 0,
      response: () => 'x',
    });
    const out = await forgeTopK(ranked, 'p', 0, 'opus', factory);
    expect(out).toEqual([]);
    expect(counter.calls).toBe(0);
  });

  it('returns [] on empty ranked input', async () => {
    const counter = { calls: 0, maxConcurrent: 0, inflight: 0 };
    const factory = countingFactory({
      counter,
      delayMs: 0,
      response: () => 'x',
    });
    const out = await forgeTopK([], 'p', 3, 'opus', factory);
    expect(out).toEqual([]);
    expect(counter.calls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 8.5 — one failure does not abort others
// ---------------------------------------------------------------------------

describe('forgeTopK — best-effort partial failure', () => {
  it('one elaboration failure does not abort the others; failed entry has elaboration=null + error', async () => {
    const ranked: BrainstormRankedIdea[] = [
      makeRanked({ idea_id: 'good1', final_score: 9, rank: 1 }),
      makeRanked({ idea_id: 'bad', final_score: 8, rank: 2 }),
      makeRanked({ idea_id: 'good2', final_score: 7, rank: 3 }),
    ];
    // Per-idea-id throwing factory: 'bad' throws, others return prose.
    const idFactory: AdapterFactory = (model: string): ModelAdapter => ({
      modelName: model,
      async generate(user: string, _system?: string): Promise<AdapterResult> {
        if (user.includes('Title: Title bad')) {
          throw new Error('simulated failure');
        }
        return {
          content: `sketch for ${user.split('\n').find((l) => l.startsWith('Title:')) ?? ''}`,
        };
      },
    });

    const out = await forgeTopK(ranked, 'p', 3, 'opus', idFactory);
    expect(out).toHaveLength(3);

    const byId = Object.fromEntries(out.map((e) => [e.idea_id, e]));
    expect(byId['good1']!.elaboration).not.toBeNull();
    expect(byId['good1']!.error).toBeUndefined();
    expect(byId['good2']!.elaboration).not.toBeNull();
    expect(byId['good2']!.error).toBeUndefined();
    expect(byId['bad']!.elaboration).toBeNull();
    expect(byId['bad']!.error).toMatch(/simulated failure/);
  });

  it('all elaborations failing still resolves the promise with every entry shaped', async () => {
    const ranked: BrainstormRankedIdea[] = [
      makeRanked({ idea_id: 'a', final_score: 9, rank: 1 }),
      makeRanked({ idea_id: 'b', final_score: 8, rank: 2 }),
    ];
    const out = await forgeTopK(ranked, 'p', 2, 'opus', throwingFactory('all down'));
    expect(out).toHaveLength(2);
    for (const e of out) {
      expect(e.elaboration).toBeNull();
      expect(e.error).toMatch(/all down/);
    }
  });
});

// ---------------------------------------------------------------------------
// Eligibility — null-score ideas excluded from top-K (design.md §130)
// ---------------------------------------------------------------------------

describe('forgeTopK — eligibility filter', () => {
  it('skips ideas with final_score === null even if they appear in the ranked array', async () => {
    const ranked: BrainstormRankedIdea[] = [
      makeRanked({ idea_id: 'skipped', final_score: null, rank: null, judge_skipped: true }),
      makeRanked({ idea_id: 'good1', final_score: 9, rank: 1 }),
      makeRanked({ idea_id: 'good2', final_score: 8, rank: 2 }),
    ];
    const out = await forgeTopK(ranked, 'p', 3, 'opus', staticFactory('sketch'));
    expect(out.map((e) => e.idea_id)).toEqual(['good1', 'good2']);
  });

  it('returns [] when every ranked idea has final_score=null', async () => {
    const ranked: BrainstormRankedIdea[] = [
      makeRanked({ idea_id: 'a', final_score: null, rank: null, judge_skipped: true }),
      makeRanked({ idea_id: 'b', final_score: null, rank: null, judge_skipped: true }),
    ];
    const counter = { calls: 0, maxConcurrent: 0, inflight: 0 };
    const factory = countingFactory({ counter, delayMs: 0, response: () => 'x' });
    const out = await forgeTopK(ranked, 'p', 5, 'opus', factory);
    expect(out).toEqual([]);
    expect(counter.calls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 8.4 — forge gated by mode (represented here at the function-contract level)
// ---------------------------------------------------------------------------
//
// The `mode === 'brainstorm/forge'` gate lives at the orchestrator level
// (Section 9's wiring). At this module's layer the equivalent contract is:
// the orchestrator MUST NOT invoke forgeTopK unless mode is 'brainstorm/forge'.
// We pin the function-level invariant here so that any future regression where
// `forgeTopK` silently elaborates on an empty/zero-k path is caught.

describe('forgeTopK — gate-friendly behaviour', () => {
  it('callers can short-circuit by passing k=0 (no adapter call, no elaborations)', async () => {
    const ranked: BrainstormRankedIdea[] = [
      makeRanked({ idea_id: 'a', final_score: 9, rank: 1 }),
    ];
    const counter = { calls: 0, maxConcurrent: 0, inflight: 0 };
    const factory = countingFactory({ counter, delayMs: 0, response: () => 'x' });
    const out = await forgeTopK(ranked, 'p', 0, 'opus', factory);
    expect(out).toEqual([]);
    expect(counter.calls).toBe(0);
  });
});
