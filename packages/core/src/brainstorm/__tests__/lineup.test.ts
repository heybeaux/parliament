/**
 * Section 3 — lineup + criteria + rank-weight tests.
 *
 * Covers tasks 3.1, 3.2, 3.3, 3.4, 3.5, 3.6 from
 * `openspec/changes/add-brainstorm-mode/tasks.md`.
 */
import { describe, it, expect } from 'vitest';
import {
  defaultBrainstormLineup,
  resolveBrainstormLineup,
  resolveRankWeights,
  BRAINSTORM_CRITERIA,
  DEFAULT_RANK_WEIGHTS,
} from '../index.js';
import type { BrainstormConfig } from '../types.js';

describe('Brainstorm lineup — defaults', () => {
  it('returns 4 divergent authors, 2 judges, 1 cluster, 1 forge elaborator', () => {
    const lineup = defaultBrainstormLineup();
    expect(lineup.divergentAuthors).toHaveLength(4);
    expect(lineup.judges).toHaveLength(2);
    expect(lineup.cluster.role).toBe('cluster');
    expect(lineup.forgeElaborator.role).toBe('forge-elaborator');
  });

  it('GPT-5 appears in both authors and judges (overlap is intentional)', () => {
    const lineup = defaultBrainstormLineup();
    const authorModels = lineup.divergentAuthors.map((a) => a.model);
    const judgeModels = lineup.judges.map((j) => j.model);
    expect(authorModels).toContain('openai/gpt-5');
    expect(judgeModels).toContain('openai/gpt-5');
    // The overlap is allowed because the rank phase enforces author-aware skip.
  });
});

describe('Brainstorm lineup — TOML resolution', () => {
  it('returns defaults when no config is provided', () => {
    expect(resolveBrainstormLineup()).toEqual(defaultBrainstormLineup());
  });

  it('returns defaults when config has no lineup section', () => {
    expect(resolveBrainstormLineup({})).toEqual(defaultBrainstormLineup());
  });

  it('strict-replaces divergentAuthors when override is provided', () => {
    const config: BrainstormConfig = {
      lineup: { divergentAuthors: ['anthropic/claude-opus-4-6', 'openai/gpt-5'] },
    };
    const lineup = resolveBrainstormLineup(config);
    expect(lineup.divergentAuthors).toHaveLength(2);
    expect(lineup.divergentAuthors.map((a) => a.model)).toEqual([
      'anthropic/claude-opus-4-6',
      'openai/gpt-5',
    ]);
    // Other roles still default.
    expect(lineup.judges).toEqual(defaultBrainstormLineup().judges);
  });

  it('strict-replaces judges independently', () => {
    const lineup = resolveBrainstormLineup({
      lineup: { judges: ['anthropic/claude-sonnet-4-6'] },
    });
    expect(lineup.judges).toHaveLength(1);
    expect(lineup.judges[0].model).toBe('anthropic/claude-sonnet-4-6');
  });

  it('rejects empty divergentAuthors override', () => {
    expect(() =>
      resolveBrainstormLineup({ lineup: { divergentAuthors: [] } }),
    ).toThrow(/divergentAuthors.*empty/);
  });

  it('rejects empty judges override', () => {
    expect(() =>
      resolveBrainstormLineup({ lineup: { judges: [] } }),
    ).toThrow(/judges.*empty/);
  });

  it('rejects whitespace-only model IDs', () => {
    expect(() =>
      resolveBrainstormLineup({
        lineup: { divergentAuthors: ['anthropic/claude-opus-4-6', '   '] },
      }),
    ).toThrow(/non-empty string/);
  });

  it('replaces cluster and forgeElaborator individually', () => {
    const lineup = resolveBrainstormLineup({
      lineup: {
        cluster: 'google/gemini-2.5-pro',
        forgeElaborator: 'openai/gpt-5',
      },
    });
    expect(lineup.cluster.model).toBe('google/gemini-2.5-pro');
    expect(lineup.forgeElaborator.model).toBe('openai/gpt-5');
  });
});

describe('Brainstorm criteria + default weights', () => {
  it('has exactly four locked criteria', () => {
    expect(BRAINSTORM_CRITERIA).toEqual(['novelty', 'feasibility', 'fit', 'evidence']);
  });

  it('default weights sum to 1.0', () => {
    const sum = BRAINSTORM_CRITERIA.reduce((acc, k) => acc + DEFAULT_RANK_WEIGHTS[k], 0);
    expect(sum).toBeCloseTo(1.0, 6);
  });

  it('default weights are equal across criteria', () => {
    const values = BRAINSTORM_CRITERIA.map((k) => DEFAULT_RANK_WEIGHTS[k]);
    expect(new Set(values).size).toBe(1);
  });
});

describe('resolveRankWeights — TOML + body partial-replace + normalization', () => {
  it('returns defaults when no config and no override', () => {
    const w = resolveRankWeights();
    for (const k of BRAINSTORM_CRITERIA) {
      expect(w[k]).toBeCloseTo(0.25, 6);
    }
  });

  it('normalizes TOML weights that do not sum to 1', () => {
    const w = resolveRankWeights({
      rank: { weights: { novelty: 2, feasibility: 1, fit: 1, evidence: 0 } },
    });
    // raw sum 4, so novelty 0.5, feasibility 0.25, fit 0.25, evidence 0
    expect(w.novelty).toBeCloseTo(0.5, 6);
    expect(w.feasibility).toBeCloseTo(0.25, 6);
    expect(w.fit).toBeCloseTo(0.25, 6);
    expect(w.evidence).toBeCloseTo(0, 6);
    const sum = BRAINSTORM_CRITERIA.reduce((acc, k) => acc + w[k], 0);
    expect(sum).toBeCloseTo(1.0, 6);
  });

  it('partial-replaces: TOML overrides only specified keys, others stay at default', () => {
    const w = resolveRankWeights({ rank: { weights: { novelty: 1 } } });
    // before normalize: novelty=1, others=0.25; sum=1.75
    expect(w.novelty).toBeCloseTo(1 / 1.75, 6);
    expect(w.feasibility).toBeCloseTo(0.25 / 1.75, 6);
  });

  it('request override stacks on top of TOML (partial-replace)', () => {
    const config: BrainstormConfig = {
      rank: { weights: { novelty: 2, feasibility: 1, fit: 1, evidence: 0 } },
    };
    // Body override bumps evidence only; TOML novelty/feasibility/fit survive.
    const w = resolveRankWeights(config, { evidence: 2 });
    // merged before normalize: novelty=2, feasibility=1, fit=1, evidence=2; sum=6
    expect(w.novelty).toBeCloseTo(2 / 6, 6);
    expect(w.evidence).toBeCloseTo(2 / 6, 6);
  });

  it('rejects negative weights', () => {
    expect(() =>
      resolveRankWeights({ rank: { weights: { novelty: -1 } } }),
    ).toThrow(/non-negative/);
  });

  it('rejects NaN / non-finite weights', () => {
    expect(() =>
      resolveRankWeights({ rank: { weights: { novelty: Number.NaN } } }),
    ).toThrow(/finite/);
    expect(() =>
      resolveRankWeights({ rank: { weights: { fit: Number.POSITIVE_INFINITY } } }),
    ).toThrow(/finite/);
  });

  it('rejects all-zero weights', () => {
    expect(() =>
      resolveRankWeights({
        rank: { weights: { novelty: 0, feasibility: 0, fit: 0, evidence: 0 } },
      }),
    ).toThrow(/at least one positive value/);
  });
});
