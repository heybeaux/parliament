/**
 * Section 7 — rank phase tests.
 *
 * Covers tasks 7.1–7.7 from `openspec/changes/add-brainstorm-mode/tasks.md`.
 *
 * What's exercised:
 *   - Independent per-judge scoring with averaged final scores (7.1, 7.2, 7.5)
 *   - Author-aware skip (7.3)
 *   - Both-judges-authored degenerate case (7.4)
 *   - Deterministic tiebreak by idea_id (7.5)
 *   - Stable rank across reruns with the same stub adapter inputs (7.7)
 *   - Whole-judge failure after retry → judge treated as skipped for all ideas
 *   - JSON parse + one-shot retry pattern
 */
import { describe, it, expect } from 'vitest';
import type { ModelAdapter, AdapterResult } from '../../adapters/base.js';
import type { AdapterFactory } from '../orchestrator.js';
import type { BrainstormIdea, BrainstormLineup } from '../types.js';
import { runRankPhase } from '../rank.js';
import { resolveRankWeights } from '../lineup.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIdea(
  overrides: Partial<BrainstormIdea> & {
    idea_id: string;
    title: string;
    one_liner: string;
    author_model: string;
  },
): BrainstormIdea {
  const { idea_id, title, one_liner, author_model, dimensions, rationale, ...rest } = overrides;
  return {
    idea_id,
    title,
    one_liner,
    dimensions: dimensions ?? ['p', 'a', 'm'],
    rationale: rationale ?? 'Rationale.',
    author_model,
    ...rest,
  };
}

function lineup(judges: string[]): BrainstormLineup {
  return {
    divergentAuthors: [],
    judges: judges.map((m) => ({ role: 'judge' as const, model: m })),
    cluster: { role: 'cluster', model: 'cluster-model' },
    forgeElaborator: { role: 'forge-elaborator', model: 'forge-model' },
  };
}

/** Per-model response (single canned string) — calls always return the same. */
function fixedResponses(map: Record<string, string>): AdapterFactory {
  return (model: string): ModelAdapter => ({
    modelName: model,
    async generate(_p: string, _s?: string): Promise<AdapterResult> {
      const r = map[model];
      if (r === undefined) throw new Error(`no response for ${model}`);
      return { content: r };
    },
  });
}

/** Per-model sequenced responses (used to exercise retry). */
function sequencedResponses(map: Record<string, string[]>): AdapterFactory {
  const counters: Record<string, number> = {};
  return (model: string): ModelAdapter => ({
    modelName: model,
    async generate(): Promise<AdapterResult> {
      const seq = map[model];
      if (seq === undefined) throw new Error(`no responses for ${model}`);
      const idx = counters[model] ?? 0;
      counters[model] = idx + 1;
      return { content: seq[Math.min(idx, seq.length - 1)] ?? '' };
    },
  });
}

/** Per-model factory where each adapter throws on generate. */
function throwingFor(modelsThatThrow: string[], map: Record<string, string>): AdapterFactory {
  return (model: string): ModelAdapter => ({
    modelName: model,
    async generate(): Promise<AdapterResult> {
      if (modelsThatThrow.includes(model)) {
        throw new Error(`${model} offline`);
      }
      const r = map[model];
      if (r === undefined) throw new Error(`no response for ${model}`);
      return { content: r };
    },
  });
}

/** Build a JSON scores payload covering every idea_id with uniform per-criterion values. */
function uniformScoresJson(ideaIds: string[], values: { novelty: number; feasibility: number; fit: number; evidence: number }): string {
  return JSON.stringify({
    scores: ideaIds.map((id) => ({
      idea_id: id,
      novelty: values.novelty,
      feasibility: values.feasibility,
      fit: values.fit,
      evidence: values.evidence,
      rationale: 'r',
    })),
  });
}

const DEFAULT_WEIGHTS = resolveRankWeights();

// ---------------------------------------------------------------------------
// 7.1 / 7.2 / 7.5 — independent judging produces averaged scores
// ---------------------------------------------------------------------------

describe('runRankPhase — independent judging averages across judges', () => {
  it('averages per-criterion scores from non-overlapping judges and weights into final_score', async () => {
    const ideas = [
      makeIdea({ idea_id: 'a', title: 'A', one_liner: 'A.', author_model: 'author-X' }),
      makeIdea({ idea_id: 'b', title: 'B', one_liner: 'B.', author_model: 'author-Y' }),
    ];

    // Judges are disjoint from authors → no author-skip in this case.
    const j1Response = JSON.stringify({
      scores: [
        { idea_id: 'a', novelty: 8, feasibility: 6, fit: 7, evidence: 5, rationale: 'j1-a' },
        { idea_id: 'b', novelty: 4, feasibility: 8, fit: 6, evidence: 7, rationale: 'j1-b' },
      ],
    });
    const j2Response = JSON.stringify({
      scores: [
        { idea_id: 'a', novelty: 6, feasibility: 8, fit: 9, evidence: 7, rationale: 'j2-a' },
        { idea_id: 'b', novelty: 2, feasibility: 6, fit: 4, evidence: 5, rationale: 'j2-b' },
      ],
    });

    const factory = fixedResponses({ 'judge-1': j1Response, 'judge-2': j2Response });
    const result = await runRankPhase({
      prompt: 'p',
      ideas,
      lineup: lineup(['judge-1', 'judge-2']),
      weights: DEFAULT_WEIGHTS,
      factory,
    });

    expect(result.warnings).toHaveLength(0);
    expect(result.ranked).toHaveLength(2);

    const a = result.ranked.find((r) => r.idea_id === 'a')!;
    const b = result.ranked.find((r) => r.idea_id === 'b')!;

    // Averages: a = (8+6)/2, (6+8)/2, (7+9)/2, (5+7)/2 = 7,7,8,6
    expect(a.criteria_scores.novelty).toBeCloseTo(7);
    expect(a.criteria_scores.feasibility).toBeCloseTo(7);
    expect(a.criteria_scores.fit).toBeCloseTo(8);
    expect(a.criteria_scores.evidence).toBeCloseTo(6);
    // Equal-weight final: (7+7+8+6)/4 = 7
    expect(a.final_score).toBeCloseTo(7);

    // b averages = 3, 7, 5, 6 → final 5.25
    expect(b.criteria_scores.novelty).toBeCloseTo(3);
    expect(b.final_score).toBeCloseTo((3 + 7 + 5 + 6) / 4);

    expect(a.judges_attempted).toEqual(['judge-1', 'judge-2']);
    expect(a.judges_skipped).toEqual([]);
    expect(a.judge_skipped).toBe(false);
  });

  it('respects non-uniform weights when computing final_score', async () => {
    const ideas = [makeIdea({ idea_id: 'a', title: 'A', one_liner: 'A.', author_model: 'auth' })];
    const response = uniformScoresJson(['a'], { novelty: 10, feasibility: 0, fit: 0, evidence: 0 });
    const factory = fixedResponses({ 'judge-1': response });

    // Push everything onto novelty.
    const weights = resolveRankWeights(undefined, { novelty: 4, feasibility: 0, fit: 0, evidence: 0 });
    const result = await runRankPhase({
      prompt: 'p',
      ideas,
      lineup: lineup(['judge-1']),
      weights,
      factory,
    });
    expect(result.ranked[0]!.final_score).toBeCloseTo(10);
  });

  it('ranks descending by final_score (higher first)', async () => {
    const ideas = [
      makeIdea({ idea_id: 'low', title: 'L', one_liner: 'L.', author_model: 'x' }),
      makeIdea({ idea_id: 'high', title: 'H', one_liner: 'H.', author_model: 'y' }),
    ];
    const r = JSON.stringify({
      scores: [
        { idea_id: 'low', novelty: 2, feasibility: 2, fit: 2, evidence: 2, rationale: '' },
        { idea_id: 'high', novelty: 9, feasibility: 9, fit: 9, evidence: 9, rationale: '' },
      ],
    });
    const result = await runRankPhase({
      prompt: 'p',
      ideas,
      lineup: lineup(['j1']),
      weights: DEFAULT_WEIGHTS,
      factory: fixedResponses({ j1: r }),
    });
    expect(result.ranked.map((x) => x.idea_id)).toEqual(['high', 'low']);
    expect(result.ranked[0]!.rank).toBe(1);
    expect(result.ranked[1]!.rank).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 7.3 — author-aware skip
// ---------------------------------------------------------------------------

describe('runRankPhase — author-aware skip', () => {
  it('skips judge for ideas authored by that same model', async () => {
    const ideas = [
      // Authored by judge-1 → judge-1 is skipped, only judge-2 counts.
      makeIdea({ idea_id: 'a', title: 'A', one_liner: 'A.', author_model: 'judge-1' }),
      // Authored by someone else → both judges count.
      makeIdea({ idea_id: 'b', title: 'B', one_liner: 'B.', author_model: 'someone-else' }),
    ];

    const j1 = uniformScoresJson(['a', 'b'], { novelty: 10, feasibility: 10, fit: 10, evidence: 10 });
    const j2 = uniformScoresJson(['a', 'b'], { novelty: 2, feasibility: 2, fit: 2, evidence: 2 });

    const result = await runRankPhase({
      prompt: 'p',
      ideas,
      lineup: lineup(['judge-1', 'judge-2']),
      weights: DEFAULT_WEIGHTS,
      factory: fixedResponses({ 'judge-1': j1, 'judge-2': j2 }),
    });

    const a = result.ranked.find((r) => r.idea_id === 'a')!;
    const b = result.ranked.find((r) => r.idea_id === 'b')!;

    // For a: judge-1 author-skipped → score reflects only judge-2 → 2.
    expect(a.judges_attempted).toEqual(['judge-2']);
    expect(a.judges_skipped).toEqual(['judge-1']);
    expect(a.judge_skipped).toBe(false); // at least one judge attempted
    expect(a.final_score).toBeCloseTo(2);

    // For b: both judges contribute → average is 6.
    expect(b.judges_attempted).toEqual(['judge-1', 'judge-2']);
    expect(b.judges_skipped).toEqual([]);
    expect(b.final_score).toBeCloseTo(6);
  });
});

// ---------------------------------------------------------------------------
// 7.4 — both-judges-authored degenerate case
// ---------------------------------------------------------------------------

describe('runRankPhase — both-judges-authored edge case', () => {
  it('surfaces score=null + judge_skipped=true when every judge authored the idea', async () => {
    // Construct an idea where author equals one judge, plus a second idea
    // where author equals the OTHER judge — but we want a single idea both
    // judges authored. The author_model is a single string, so "both judges
    // authored" means author_model is BOTH judges simultaneously, which is
    // impossible. Instead, the practical interpretation (per design.md) is:
    // every judge has the same model as this idea's author. With one judge,
    // that's "judge matches author". With two judges of the same model, both
    // are skipped. Replicate via a single-judge lineup where the judge IS the
    // author — equivalent semantically to "every judge authored".
    const ideas = [
      makeIdea({ idea_id: 'authored', title: 'X', one_liner: 'X.', author_model: 'judge-1' }),
    ];
    // Single-judge lineup; judge-1 IS the author of `authored`.
    const result = await runRankPhase({
      prompt: 'p',
      ideas,
      lineup: lineup(['judge-1']),
      weights: DEFAULT_WEIGHTS,
      // Factory must not be called — every judge is author-skipped, so we
      // never need a real response. Throw to assert this.
      factory: throwingFor(['judge-1'], {}),
    });

    const a = result.ranked[0]!;
    expect(a.final_score).toBeNull();
    expect(a.judge_skipped).toBe(true);
    expect(a.judges_attempted).toEqual([]);
    expect(a.judges_skipped).toEqual(['judge-1']);
    expect(a.criteria_scores.novelty).toBeNull();
    expect(a.rank).toBeNull();
  });

  it('null-score ideas sort to the end behind scored ideas', async () => {
    const ideas = [
      // Authored by both judges (both same model "j1") — sort to bottom.
      makeIdea({ idea_id: 'bothskip', title: 'Z', one_liner: 'Z.', author_model: 'j1' }),
      // Normal idea — gets scored.
      makeIdea({ idea_id: 'normal', title: 'N', one_liner: 'N.', author_model: 'someone' }),
    ];
    // Lineup has TWO judges, BOTH using the same model 'j1' (the author).
    const lu: BrainstormLineup = {
      divergentAuthors: [],
      judges: [
        { role: 'judge', model: 'j1' },
        { role: 'judge', model: 'j1' },
      ],
      cluster: { role: 'cluster', model: 'cm' },
      forgeElaborator: { role: 'forge-elaborator', model: 'fm' },
    };

    // For 'normal', j1 isn't the author → j1 scores it. For 'bothskip',
    // both judges (both 'j1') match the author → all skipped.
    const _j1 = uniformScoresJson(['normal'], { novelty: 5, feasibility: 5, fit: 5, evidence: 5 });

    const result = await runRankPhase({
      prompt: 'p',
      ideas,
      lineup: lu,
      weights: DEFAULT_WEIGHTS,
      // 'bothskip' is fully author-skipped; the judge will still be invoked for
      // 'normal' because that idea has a different author. We invoke the judge
      // once with ALL ideas in the prompt — but the prompt asks for scores on
      // every idea including the author-skipped one. The judge response must
      // therefore include 'bothskip' too. We supply a benign score; the
      // orchestrator discards it via author-skip.
      factory: fixedResponses({
        j1: JSON.stringify({
          scores: [
            { idea_id: 'normal', novelty: 5, feasibility: 5, fit: 5, evidence: 5, rationale: '' },
            { idea_id: 'bothskip', novelty: 7, feasibility: 7, fit: 7, evidence: 7, rationale: '' },
          ],
        }),
      }),
    });

    expect(result.ranked.map((r) => r.idea_id)).toEqual(['normal', 'bothskip']);
    expect(result.ranked[0]!.rank).toBe(1);
    expect(result.ranked[1]!.rank).toBeNull();
    expect(result.ranked[1]!.final_score).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 7.5 — deterministic tiebreak by idea_id
// ---------------------------------------------------------------------------

describe('runRankPhase — deterministic tiebreak', () => {
  it('breaks final_score ties by idea_id ascending', async () => {
    const ideas = [
      makeIdea({ idea_id: 'zzz', title: 'Z', one_liner: 'Z.', author_model: 'x' }),
      makeIdea({ idea_id: 'aaa', title: 'A', one_liner: 'A.', author_model: 'x' }),
      makeIdea({ idea_id: 'mmm', title: 'M', one_liner: 'M.', author_model: 'x' }),
    ];
    // All ideas get identical scores → ties on final_score.
    const j = uniformScoresJson(['zzz', 'aaa', 'mmm'], { novelty: 5, feasibility: 5, fit: 5, evidence: 5 });

    const result = await runRankPhase({
      prompt: 'p',
      ideas,
      lineup: lineup(['judge']),
      weights: DEFAULT_WEIGHTS,
      factory: fixedResponses({ judge: j }),
    });

    expect(result.ranked.map((r) => r.idea_id)).toEqual(['aaa', 'mmm', 'zzz']);
  });

  it('breaks ties between null-score ideas by idea_id ascending', async () => {
    const ideas = [
      makeIdea({ idea_id: 'zskip', title: 'Z', one_liner: 'Z.', author_model: 'self' }),
      makeIdea({ idea_id: 'askip', title: 'A', one_liner: 'A.', author_model: 'self' }),
    ];
    const result = await runRankPhase({
      prompt: 'p',
      ideas,
      lineup: lineup(['self']),
      weights: DEFAULT_WEIGHTS,
      factory: throwingFor(['self'], {}),
    });
    expect(result.ranked.map((r) => r.idea_id)).toEqual(['askip', 'zskip']);
  });
});

// ---------------------------------------------------------------------------
// 7.7 — stability across reruns
// ---------------------------------------------------------------------------

describe('runRankPhase — rerun stability', () => {
  it('two runs with the same stub adapter produce identical ranked arrays', async () => {
    const ideas = [
      makeIdea({ idea_id: 'a', title: 'A', one_liner: 'A.', author_model: 'x' }),
      makeIdea({ idea_id: 'b', title: 'B', one_liner: 'B.', author_model: 'y' }),
      makeIdea({ idea_id: 'c', title: 'C', one_liner: 'C.', author_model: 'z' }),
    ];
    const r = JSON.stringify({
      scores: [
        { idea_id: 'a', novelty: 6, feasibility: 7, fit: 8, evidence: 9, rationale: '' },
        { idea_id: 'b', novelty: 9, feasibility: 8, fit: 7, evidence: 6, rationale: '' },
        { idea_id: 'c', novelty: 5, feasibility: 5, fit: 5, evidence: 5, rationale: '' },
      ],
    });

    const factory = fixedResponses({ j: r });
    const lu = lineup(['j']);

    const run1 = await runRankPhase({ prompt: 'p', ideas, lineup: lu, weights: DEFAULT_WEIGHTS, factory });
    const run2 = await runRankPhase({ prompt: 'p', ideas, lineup: lu, weights: DEFAULT_WEIGHTS, factory });

    expect(run1.ranked.map((x) => [x.idea_id, x.final_score, x.rank]))
      .toEqual(run2.ranked.map((x) => [x.idea_id, x.final_score, x.rank]));
  });
});

// ---------------------------------------------------------------------------
// Judge failure modes
// ---------------------------------------------------------------------------

describe('runRankPhase — judge failure handling', () => {
  it('treats a judge as skipped for ALL ideas when it fails parse after retry', async () => {
    const ideas = [
      makeIdea({ idea_id: 'a', title: 'A', one_liner: 'A.', author_model: 'x' }),
      makeIdea({ idea_id: 'b', title: 'B', one_liner: 'B.', author_model: 'y' }),
    ];
    const j2Good = uniformScoresJson(['a', 'b'], { novelty: 4, feasibility: 4, fit: 4, evidence: 4 });

    // judge-bad returns garbage twice; judge-good returns valid JSON.
    const factory = sequencedResponses({
      'judge-bad': ['not json', 'still not json'],
      'judge-good': [j2Good],
    });

    const result = await runRankPhase({
      prompt: 'p',
      ideas,
      lineup: lineup(['judge-bad', 'judge-good']),
      weights: DEFAULT_WEIGHTS,
      factory,
    });

    expect(result.warnings.some((w) => w.includes('judge-bad'))).toBe(true);
    for (const idea of result.ranked) {
      expect(idea.judges_attempted).toEqual(['judge-good']);
      expect(idea.judges_skipped).toContain('judge-bad');
      expect(idea.final_score).toBeCloseTo(4);
    }
  });

  it('treats a judge as skipped when adapter throws', async () => {
    const ideas = [makeIdea({ idea_id: 'a', title: 'A', one_liner: 'A.', author_model: 'x' })];
    const good = uniformScoresJson(['a'], { novelty: 8, feasibility: 8, fit: 8, evidence: 8 });

    const factory = throwingFor(['judge-bad'], { 'judge-good': good });

    const result = await runRankPhase({
      prompt: 'p',
      ideas,
      lineup: lineup(['judge-bad', 'judge-good']),
      weights: DEFAULT_WEIGHTS,
      factory,
    });

    expect(result.ranked[0]!.judges_attempted).toEqual(['judge-good']);
    expect(result.ranked[0]!.judges_skipped).toEqual(['judge-bad']);
    expect(result.ranked[0]!.final_score).toBeCloseTo(8);
    expect(result.warnings[0]).toMatch(/judge-bad/);
  });

  it('one-shot retry succeeds after first parse fails', async () => {
    const ideas = [makeIdea({ idea_id: 'a', title: 'A', one_liner: 'A.', author_model: 'x' })];
    const good = uniformScoresJson(['a'], { novelty: 5, feasibility: 5, fit: 5, evidence: 5 });
    const factory = sequencedResponses({ j: ['this is prose', good] });

    const result = await runRankPhase({
      prompt: 'p',
      ideas,
      lineup: lineup(['j']),
      weights: DEFAULT_WEIGHTS,
      factory,
    });

    expect(result.warnings).toHaveLength(0);
    expect(result.ranked[0]!.final_score).toBeCloseTo(5);
  });

  it('fenced ```json output is accepted', async () => {
    const ideas = [makeIdea({ idea_id: 'a', title: 'A', one_liner: 'A.', author_model: 'x' })];
    const fenced =
      '```json\n' + uniformScoresJson(['a'], { novelty: 7, feasibility: 7, fit: 7, evidence: 7 }) + '\n```';
    const factory = fixedResponses({ j: fenced });

    const result = await runRankPhase({
      prompt: 'p',
      ideas,
      lineup: lineup(['j']),
      weights: DEFAULT_WEIGHTS,
      factory,
    });
    expect(result.ranked[0]!.final_score).toBeCloseTo(7);
  });

  it('rejects a judge response with missing idea_id coverage', async () => {
    const ideas = [
      makeIdea({ idea_id: 'a', title: 'A', one_liner: 'A.', author_model: 'x' }),
      makeIdea({ idea_id: 'b', title: 'B', one_liner: 'B.', author_model: 'y' }),
    ];
    // Judge returns scores for 'a' only — invalid; soft-skip after retry.
    const onlyA = JSON.stringify({
      scores: [{ idea_id: 'a', novelty: 1, feasibility: 1, fit: 1, evidence: 1, rationale: '' }],
    });
    const factory = sequencedResponses({ j: [onlyA, onlyA] });
    const result = await runRankPhase({
      prompt: 'p',
      ideas,
      lineup: lineup(['j']),
      weights: DEFAULT_WEIGHTS,
      factory,
    });
    expect(result.warnings.length).toBeGreaterThan(0);
    // With every judge skipped, all ideas surface null score.
    for (const r of result.ranked) {
      expect(r.final_score).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Output shape / phase record
// ---------------------------------------------------------------------------

describe('runRankPhase — output shape', () => {
  it('phase record carries ranked + judgings; ranked entries include enrichment fields', async () => {
    const ideas = [
      makeIdea({
        idea_id: 'a',
        title: 'Alpha',
        one_liner: 'Alpha liner.',
        author_model: 'auth',
        cluster: 'AI productivity',
        dimensions: ['prob', 'aud', 'mech'],
        rationale: 'Why alpha.',
      }),
    ];
    const r = uniformScoresJson(['a'], { novelty: 5, feasibility: 6, fit: 7, evidence: 8 });
    const result = await runRankPhase({
      prompt: 'p',
      ideas,
      lineup: lineup(['j']),
      weights: DEFAULT_WEIGHTS,
      factory: fixedResponses({ j: r }),
      clusterMap: { 'AI productivity': ['a'] },
    });

    expect(result.phaseRecord.phase).toBe('idea-rank');
    expect(result.phaseRecord.ranked).toBeDefined();
    expect(result.phaseRecord.ranked).toHaveLength(1);
    expect(result.phaseRecord.judgings!.length).toBeGreaterThan(0);

    const entry = result.ranked[0]!;
    expect(entry.title).toBe('Alpha');
    expect(entry.one_liner).toBe('Alpha liner.');
    expect(entry.dimensions).toEqual(['prob', 'aud', 'mech']);
    expect(entry.rationale).toBe('Why alpha.');
    expect(entry.cluster).toBe('AI productivity');
    expect(entry.rank).toBe(1);
  });

  it('empty ideas → empty ranked, no judges invoked', async () => {
    const result = await runRankPhase({
      prompt: 'p',
      ideas: [],
      lineup: lineup(['j']),
      weights: DEFAULT_WEIGHTS,
      // Factory must not be called.
      factory: throwingFor(['j'], {}),
    });
    expect(result.ranked).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.phaseRecord.phase).toBe('idea-rank');
  });
});
