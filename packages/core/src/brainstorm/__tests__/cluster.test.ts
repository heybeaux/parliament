/**
 * Section 6.4 — cluster phase tests.
 *
 * Covers tasks 6.1–6.4 from `openspec/changes/add-brainstorm-mode/tasks.md`.
 */
import { describe, it, expect } from 'vitest';
import type { ModelAdapter, AdapterResult } from '../../adapters/base.js';
import type { BrainstormIdea } from '../types.js';
import type { AdapterFactory } from '../orchestrator.js';
import { runClusterPhase } from '../cluster.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIdea(
  overrides: Partial<BrainstormIdea> & { idea_id: string; title: string; one_liner: string; author_model: string },
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

function staticFactory(model: string, response: string): AdapterFactory {
  return (m: string): ModelAdapter => ({
    modelName: m,
    async generate(_p: string, _s?: string): Promise<AdapterResult> {
      if (m !== model) throw new Error(`unexpected model ${m}`);
      return { content: response };
    },
  });
}

/** Factory whose adapter throws on every generate call. */
function throwingFactory(): AdapterFactory {
  return (m: string): ModelAdapter => ({
    modelName: m,
    async generate(): Promise<AdapterResult> {
      throw new Error('clusterer offline');
    },
  });
}

/** Factory that returns different responses on first vs subsequent calls. */
function sequencedFactory(responses: string[]): AdapterFactory {
  let idx = 0;
  return (m: string): ModelAdapter => ({
    modelName: m,
    async generate(): Promise<AdapterResult> {
      const r = responses[Math.min(idx, responses.length - 1)];
      idx++;
      return { content: r ?? '' };
    },
  });
}

// ---------------------------------------------------------------------------
// Clean cluster
// ---------------------------------------------------------------------------

describe('runClusterPhase — clean cluster', () => {
  it('assigns clusters to all input ideas and populates cluster_map', async () => {
    const ideas: BrainstormIdea[] = [
      makeIdea({ idea_id: 'aaaa', title: 'AI todo', one_liner: 'AI organizes your day.', author_model: 'm-a' }),
      makeIdea({ idea_id: 'bbbb', title: 'AI inbox', one_liner: 'AI triages email.', author_model: 'm-b' }),
      makeIdea({ idea_id: 'cccc', title: 'AR maps', one_liner: 'AR navigation overlay.', author_model: 'm-c' }),
    ];

    const response = JSON.stringify({
      clusters: [
        { label: 'AI productivity', idea_ids: ['aaaa', 'bbbb'] },
        { label: 'Spatial computing', idea_ids: ['cccc'] },
      ],
    });

    const factory = staticFactory('cluster-model', response);
    const result = await runClusterPhase({
      prompt: 'brainstorm prompt',
      ideas,
      clusterModel: 'cluster-model',
      factory,
    });

    expect(result.warnings).toHaveLength(0);
    expect(result.ideas).toHaveLength(3);
    const byId = Object.fromEntries(result.ideas.map((i) => [i.idea_id, i.cluster]));
    expect(byId['aaaa']).toBe('AI productivity');
    expect(byId['bbbb']).toBe('AI productivity');
    expect(byId['cccc']).toBe('Spatial computing');

    expect(result.phaseRecord.phase).toBe('idea-cluster');
    expect(result.phaseRecord.cluster_map).toEqual({
      'AI productivity': ['aaaa', 'bbbb'],
      'Spatial computing': ['cccc'],
    });
    expect(result.phaseRecord.warnings).toBeUndefined();
  });

  it('preserves original idea order on output', async () => {
    const ideas: BrainstormIdea[] = [
      makeIdea({ idea_id: 'i1', title: 'One', one_liner: 'First.', author_model: 'm' }),
      makeIdea({ idea_id: 'i2', title: 'Two', one_liner: 'Second.', author_model: 'm' }),
      makeIdea({ idea_id: 'i3', title: 'Three', one_liner: 'Third.', author_model: 'm' }),
    ];
    const response = JSON.stringify({
      clusters: [
        { label: 'B group', idea_ids: ['i3'] },
        { label: 'A group', idea_ids: ['i1', 'i2'] },
      ],
    });

    const result = await runClusterPhase({
      prompt: 'p',
      ideas,
      clusterModel: 'cm',
      factory: staticFactory('cm', response),
    });

    expect(result.ideas.map((i) => i.idea_id)).toEqual(['i1', 'i2', 'i3']);
  });

  it('accepts fenced JSON output', async () => {
    const ideas = [makeIdea({ idea_id: 'i1', title: 'T', one_liner: 'L.', author_model: 'm' })];
    const fenced = '```json\n' + JSON.stringify({ clusters: [{ label: 'Solo', idea_ids: ['i1'] }] }) + '\n```';
    const result = await runClusterPhase({
      prompt: 'p',
      ideas,
      clusterModel: 'cm',
      factory: staticFactory('cm', fenced),
    });
    expect(result.ideas[0]!.cluster).toBe('Solo');
  });

  it('one-shot retry succeeds after first parse fails', async () => {
    const ideas = [makeIdea({ idea_id: 'i1', title: 'T', one_liner: 'L.', author_model: 'm' })];
    const good = JSON.stringify({ clusters: [{ label: 'X', idea_ids: ['i1'] }] });
    const factory = sequencedFactory(['this is not json', good]);

    const result = await runClusterPhase({
      prompt: 'p',
      ideas,
      clusterModel: 'cm',
      factory,
    });

    expect(result.ideas[0]!.cluster).toBe('X');
    expect(result.warnings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Soft-fail: call throws
// ---------------------------------------------------------------------------

describe('runClusterPhase — soft-fail on adapter throw', () => {
  it('returns ideas with cluster=null and warns when clusterer call throws', async () => {
    const ideas: BrainstormIdea[] = [
      makeIdea({ idea_id: 'i1', title: 'A', one_liner: 'A.', author_model: 'm-a' }),
      makeIdea({ idea_id: 'i2', title: 'B', one_liner: 'B.', author_model: 'm-b' }),
    ];

    const result = await runClusterPhase({
      prompt: 'p',
      ideas,
      clusterModel: 'broken',
      factory: throwingFactory(),
    });

    expect(result.ideas).toHaveLength(2);
    for (const idea of result.ideas) {
      expect(idea.cluster).toBeNull();
    }
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toMatch(/cluster/i);
    expect(result.warnings[0]).toMatch(/broken/);
    expect(result.phaseRecord.warnings).toBeDefined();
    expect(result.phaseRecord.cluster_map).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Soft-fail: unparseable after retry
// ---------------------------------------------------------------------------

describe('runClusterPhase — soft-fail on unparseable JSON', () => {
  it('soft-fails when both parse and retry produce non-JSON', async () => {
    const ideas = [makeIdea({ idea_id: 'i1', title: 'T', one_liner: 'L.', author_model: 'm' })];
    const factory = sequencedFactory(['not json', 'still not json']);

    const result = await runClusterPhase({
      prompt: 'p',
      ideas,
      clusterModel: 'cm',
      factory,
    });

    expect(result.ideas[0]!.cluster).toBeNull();
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toMatch(/unparseable/);
  });

  it('soft-fails when cluster output references unknown idea_id', async () => {
    const ideas = [makeIdea({ idea_id: 'i1', title: 'T', one_liner: 'L.', author_model: 'm' })];
    const response = JSON.stringify({ clusters: [{ label: 'X', idea_ids: ['unknown-id'] }] });
    // Both first and retry return same invalid output to ensure soft-fail.
    const factory = sequencedFactory([response, response]);

    const result = await runClusterPhase({
      prompt: 'p',
      ideas,
      clusterModel: 'cm',
      factory,
    });

    expect(result.ideas[0]!.cluster).toBeNull();
    expect(result.warnings[0]).toMatch(/invalid/);
  });

  it('soft-fails when an idea is left unassigned (orphan)', async () => {
    const ideas = [
      makeIdea({ idea_id: 'i1', title: 'A', one_liner: 'A.', author_model: 'm' }),
      makeIdea({ idea_id: 'i2', title: 'B', one_liner: 'B.', author_model: 'm' }),
    ];
    const response = JSON.stringify({ clusters: [{ label: 'X', idea_ids: ['i1'] }] });
    const factory = sequencedFactory([response, response]);

    const result = await runClusterPhase({
      prompt: 'p',
      ideas,
      clusterModel: 'cm',
      factory,
    });

    expect(result.ideas.every((i) => i.cluster === null)).toBe(true);
  });

  it('soft-fails when same idea_id appears in two clusters', async () => {
    const ideas = [
      makeIdea({ idea_id: 'i1', title: 'A', one_liner: 'A.', author_model: 'm' }),
      makeIdea({ idea_id: 'i2', title: 'B', one_liner: 'B.', author_model: 'm' }),
    ];
    const response = JSON.stringify({
      clusters: [
        { label: 'X', idea_ids: ['i1', 'i2'] },
        { label: 'Y', idea_ids: ['i1'] },
      ],
    });
    const factory = sequencedFactory([response, response]);

    const result = await runClusterPhase({
      prompt: 'p',
      ideas,
      clusterModel: 'cm',
      factory,
    });

    expect(result.ideas.every((i) => i.cluster === null)).toBe(true);
    expect(result.warnings[0]).toMatch(/invalid/);
  });
});

// ---------------------------------------------------------------------------
// Empty / degenerate inputs
// ---------------------------------------------------------------------------

describe('runClusterPhase — empty / degenerate inputs', () => {
  it('returns empty result with no warnings on empty ideas', async () => {
    const result = await runClusterPhase({
      prompt: 'p',
      ideas: [],
      clusterModel: 'cm',
      // Factory must not be called.
      factory: throwingFactory(),
    });
    expect(result.ideas).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
    expect(result.phaseRecord.phase).toBe('idea-cluster');
    expect(result.phaseRecord.cluster_map).toEqual({});
  });

  it('returns cluster=null with no warnings when all ideas are unstructured', async () => {
    const ideas: BrainstormIdea[] = [
      {
        idea_id: 'm#0_0',
        title: '',
        one_liner: '',
        dimensions: [],
        rationale: 'raw prose',
        author_model: 'm',
        unstructured: true,
      },
    ];

    const result = await runClusterPhase({
      prompt: 'p',
      ideas,
      clusterModel: 'cm',
      // Factory must not be called — no structured ideas to cluster.
      factory: throwingFactory(),
    });

    expect(result.ideas[0]!.cluster).toBeNull();
    expect(result.warnings).toHaveLength(0);
  });

  it('unstructured ideas mixed with structured ideas: only structured ones get cluster labels', async () => {
    const ideas: BrainstormIdea[] = [
      makeIdea({ idea_id: 'good', title: 'Good', one_liner: 'Good liner.', author_model: 'm' }),
      {
        idea_id: 'm#1_0',
        title: '',
        one_liner: '',
        dimensions: [],
        rationale: 'raw prose',
        author_model: 'm',
        unstructured: true,
      },
    ];

    const response = JSON.stringify({ clusters: [{ label: 'Solo', idea_ids: ['good'] }] });
    const result = await runClusterPhase({
      prompt: 'p',
      ideas,
      clusterModel: 'cm',
      factory: staticFactory('cm', response),
    });

    expect(result.ideas.find((i) => i.idea_id === 'good')!.cluster).toBe('Solo');
    expect(result.ideas.find((i) => i.idea_id === 'm#1_0')!.cluster).toBeNull();
    expect(result.warnings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Output shape — task 6.2 / 6.4 "cluster output passed to rank"
// ---------------------------------------------------------------------------

describe('runClusterPhase — output shape for downstream rank', () => {
  it('phase record exposes the cluster_map shape rank phase will consume', async () => {
    const ideas: BrainstormIdea[] = [
      makeIdea({ idea_id: 'a', title: 'A', one_liner: 'A.', author_model: 'm' }),
      makeIdea({ idea_id: 'b', title: 'B', one_liner: 'B.', author_model: 'm' }),
    ];
    const response = JSON.stringify({
      clusters: [
        { label: 'Group One', idea_ids: ['a'] },
        { label: 'Group Two', idea_ids: ['b'] },
      ],
    });

    const result = await runClusterPhase({
      prompt: 'p',
      ideas,
      clusterModel: 'cm',
      factory: staticFactory('cm', response),
    });

    // The rank phase will receive `ideas` (each carrying `cluster`) and
    // `cluster_map` (label → idea_ids). Both must be present and consistent.
    expect(result.phaseRecord.cluster_map).toBeDefined();
    const labels = Object.keys(result.phaseRecord.cluster_map!);
    expect(labels).toContain('Group One');
    expect(labels).toContain('Group Two');

    // Round-trip consistency: every idea's cluster label is a key in cluster_map,
    // and every idea_id in cluster_map matches an idea.
    const idsInMap = new Set<string>();
    for (const [, ids] of Object.entries(result.phaseRecord.cluster_map!)) {
      for (const id of ids) idsInMap.add(id);
    }
    for (const idea of result.ideas) {
      if (idea.cluster !== null) {
        expect(idsInMap.has(idea.idea_id)).toBe(true);
        expect(result.phaseRecord.cluster_map![idea.cluster!]).toContain(idea.idea_id);
      }
    }
  });
});
