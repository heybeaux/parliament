/**
 * Section 4.5 — divergent-generation phase tests.
 *
 * Covers tasks 4.1–4.5 from `openspec/changes/add-brainstorm-mode/tasks.md`.
 */
import { describe, it, expect } from 'vitest';
import type { ModelAdapter, AdapterResult } from '../../adapters/base.js';
import type { BrainstormLineup } from '../types.js';
import type { AdapterFactory } from '../orchestrator.js';
import { runDivergentGeneration } from '../divergent.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIdeasJson(count: number, prefix = 'idea'): string {
  const ideas = Array.from({ length: count }, (_, i) => ({
    title: `${prefix} ${i + 1}`,
    one_liner: `One liner for ${prefix} ${i + 1}.`,
    dimensions: {
      problem: `Problem ${i + 1}`,
      audience: `Audience ${i + 1}`,
      mechanism: `Mechanism ${i + 1}`,
    },
    rationale: `Rationale for ${prefix} ${i + 1}.`,
  }));
  return JSON.stringify({ ideas });
}

function singleAuthorLineup(model: string): BrainstormLineup {
  return {
    divergentAuthors: [{ role: 'divergent-author', model }],
    judges: [],
    cluster: { role: 'cluster', model: 'cluster-model' },
    forgeElaborator: { role: 'forge-elaborator', model: 'forge-model' },
  };
}

function twoAuthorLineup(modelA: string, modelB: string): BrainstormLineup {
  return {
    divergentAuthors: [
      { role: 'divergent-author', model: modelA },
      { role: 'divergent-author', model: modelB },
    ],
    judges: [],
    cluster: { role: 'cluster', model: 'cluster-model' },
    forgeElaborator: { role: 'forge-elaborator', model: 'forge-model' },
  };
}

function makeSimpleFactory(responses: Record<string, string>): AdapterFactory {
  return (model: string): ModelAdapter => ({
    modelName: model,
    async generate(_prompt: string, _system?: string): Promise<AdapterResult> {
      const response = responses[model];
      if (response === undefined) {
        throw new Error(`Test stub: no response for model "${model}"`);
      }
      return { content: response };
    },
  });
}

// ---------------------------------------------------------------------------
// K=1 / K=5 / K=10 — correct shape
// ---------------------------------------------------------------------------

describe('runDivergentGeneration — idea counts', () => {
  it('K=1 produces 1 idea with correct shape', async () => {
    const factory = makeSimpleFactory({ 'model-a': makeIdeasJson(1) });
    const result = await runDivergentGeneration({
      prompt: 'test prompt',
      lineup: singleAuthorLineup('model-a'),
      ideasPerAuthor: 1,
      factory,
    });

    expect(result.ideas).toHaveLength(1);
    expect(result.warnings).toHaveLength(0);
    const idea = result.ideas[0]!;
    expect(idea.title).toBe('idea 1');
    expect(idea.one_liner).toBe('One liner for idea 1.');
    expect(idea.dimensions).toHaveLength(3);
    expect(idea.rationale).toBe('Rationale for idea 1.');
    expect(idea.author_model).toBe('model-a');
    expect(idea.unstructured).toBeUndefined();
    expect(idea.idea_id).toContain('model-a');
  });

  it('K=5 produces 5 ideas per author', async () => {
    const factory = makeSimpleFactory({ 'model-a': makeIdeasJson(5) });
    const result = await runDivergentGeneration({
      prompt: 'test prompt',
      lineup: singleAuthorLineup('model-a'),
      ideasPerAuthor: 5,
      factory,
    });

    expect(result.ideas).toHaveLength(5);
    expect(result.warnings).toHaveLength(0);
    for (const idea of result.ideas) {
      expect(idea.author_model).toBe('model-a');
      expect(idea.dimensions).toHaveLength(3);
    }
  });

  it('K=10 produces 10 ideas per author', async () => {
    const factory = makeSimpleFactory({ 'model-a': makeIdeasJson(10) });
    const result = await runDivergentGeneration({
      prompt: 'test prompt',
      lineup: singleAuthorLineup('model-a'),
      ideasPerAuthor: 10,
      factory,
    });

    expect(result.ideas).toHaveLength(10);
    expect(result.warnings).toHaveLength(0);
  });

  it('multiple authors produce combined idea list', async () => {
    const factory = makeSimpleFactory({
      'model-a': makeIdeasJson(3, 'alpha'),
      'model-b': makeIdeasJson(3, 'beta'),
    });
    const result = await runDivergentGeneration({
      prompt: 'test',
      lineup: twoAuthorLineup('model-a', 'model-b'),
      ideasPerAuthor: 3,
      factory,
    });

    expect(result.ideas).toHaveLength(6);
    const authorModels = result.ideas.map((i) => i.author_model);
    expect(authorModels.filter((m) => m === 'model-a')).toHaveLength(3);
    expect(authorModels.filter((m) => m === 'model-b')).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// PhaseRecord shape
// ---------------------------------------------------------------------------

describe('runDivergentGeneration — phaseRecord', () => {
  it('phaseRecord.phase is divergent-generation', async () => {
    const factory = makeSimpleFactory({ 'model-a': makeIdeasJson(1) });
    const result = await runDivergentGeneration({
      prompt: 'test',
      lineup: singleAuthorLineup('model-a'),
      ideasPerAuthor: 1,
      factory,
    });

    expect(result.phaseRecord.phase).toBe('divergent-generation');
    expect(result.phaseRecord.ideas).toHaveLength(1);
    expect(result.phaseRecord.warnings).toBeUndefined();
  });

  it('phaseRecord.warnings present when warnings exist', async () => {
    // Return more ideas than requested → K-mismatch warning.
    const factory = makeSimpleFactory({ 'model-a': makeIdeasJson(3) });
    const result = await runDivergentGeneration({
      prompt: 'test',
      lineup: singleAuthorLineup('model-a'),
      ideasPerAuthor: 2,
      factory,
    });

    expect(result.phaseRecord.warnings).toBeDefined();
    expect(result.phaseRecord.warnings!.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Parse retry path
// ---------------------------------------------------------------------------

describe('runDivergentGeneration — JSON parse retry', () => {
  it('retries on broken JSON, succeeds on second attempt, records warning', async () => {
    let callCount = 0;
    const factory = (model: string): ModelAdapter => ({
      modelName: model,
      async generate(_prompt: string, _system?: string): Promise<AdapterResult> {
        callCount++;
        if (callCount === 1) {
          return { content: 'this is not json at all' };
        }
        return { content: makeIdeasJson(2) };
      },
    });

    const result = await runDivergentGeneration({
      prompt: 'test',
      lineup: singleAuthorLineup('model-a'),
      ideasPerAuthor: 2,
      factory,
    });

    expect(callCount).toBe(2);
    expect(result.ideas).toHaveLength(2);
    expect(result.ideas[0]!.unstructured).toBeUndefined();
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/retrying/);
  });
});

// ---------------------------------------------------------------------------
// Prose fallback — unstructured: true
// ---------------------------------------------------------------------------

describe('runDivergentGeneration — prose fallback', () => {
  it('surfaces unstructured idea when both parse attempts fail', async () => {
    const rawProse = 'Here are my brilliant ideas: they are great!';
    const factory = (_model: string): ModelAdapter => ({
      modelName: 'model-a',
      async generate(): Promise<AdapterResult> {
        return { content: rawProse };
      },
    });

    const result = await runDivergentGeneration({
      prompt: 'test',
      lineup: singleAuthorLineup('model-a'),
      ideasPerAuthor: 3,
      factory,
    });

    expect(result.ideas).toHaveLength(1);
    const idea = result.ideas[0]!;
    expect(idea.unstructured).toBe(true);
    expect(idea.author_model).toBe('model-a');
    expect(idea.rationale).toContain('brilliant ideas');
    expect(result.warnings.length).toBeGreaterThanOrEqual(2);
  });

  it('prose fallback idea has author_model populated', async () => {
    const factory = (_model: string): ModelAdapter => ({
      modelName: 'model-x',
      async generate(): Promise<AdapterResult> {
        return { content: 'not json' };
      },
    });

    const result = await runDivergentGeneration({
      prompt: 'test',
      lineup: singleAuthorLineup('model-x'),
      ideasPerAuthor: 1,
      factory,
    });

    expect(result.ideas[0]!.author_model).toBe('model-x');
  });
});

// ---------------------------------------------------------------------------
// Parallelism — all authors called in parallel
// ---------------------------------------------------------------------------

describe('runDivergentGeneration — parallelism', () => {
  it('all adapter calls start before any resolves', async () => {
    const callOrder: string[] = [];
    const resolveCallbacks: Array<() => void> = [];

    const factory = (model: string): ModelAdapter => ({
      modelName: model,
      generate(): Promise<AdapterResult> {
        callOrder.push(`start:${model}`);
        return new Promise((resolve) => {
          resolveCallbacks.push(() => {
            callOrder.push(`end:${model}`);
            resolve({ content: makeIdeasJson(1, model) });
          });
        });
      },
    });

    const runPromise = runDivergentGeneration({
      prompt: 'test',
      lineup: twoAuthorLineup('model-a', 'model-b'),
      ideasPerAuthor: 1,
      factory,
    });

    // Drain microtask queue so both adapters fire.
    await Promise.resolve();
    await Promise.resolve();

    // Both calls should have started before either resolved.
    expect(callOrder).toContain('start:model-a');
    expect(callOrder).toContain('start:model-b');
    expect(callOrder.filter((e) => e.startsWith('end:'))).toHaveLength(0);

    // Now resolve them and collect results.
    for (const cb of resolveCallbacks) cb();
    await runPromise;
  });
});

// ---------------------------------------------------------------------------
// K-mismatch warning
// ---------------------------------------------------------------------------

describe('runDivergentGeneration — K mismatch', () => {
  it('records a warning when author returns wrong number of ideas', async () => {
    const factory = makeSimpleFactory({ 'model-a': makeIdeasJson(3) });
    const result = await runDivergentGeneration({
      prompt: 'test',
      lineup: singleAuthorLineup('model-a'),
      ideasPerAuthor: 5,
      factory,
    });

    expect(result.ideas).toHaveLength(3);
    expect(result.warnings.some((w) => w.includes('expected 5'))).toBe(true);
  });

  it('ideas are still returned with correct author_model on mismatch', async () => {
    const factory = makeSimpleFactory({ 'model-a': makeIdeasJson(2) });
    const result = await runDivergentGeneration({
      prompt: 'test',
      lineup: singleAuthorLineup('model-a'),
      ideasPerAuthor: 5,
      factory,
    });

    for (const idea of result.ideas) {
      expect(idea.author_model).toBe('model-a');
    }
  });
});
