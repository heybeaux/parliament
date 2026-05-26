import { describe, expect, it } from 'vitest';
import type { ModelAdapter, AdapterResult } from '../../adapters/base.js';
import { defaultLineup } from '../lineup.js';
import { runIdeation, type AdapterFactory } from '../orchestrator.js';

/**
 * Test adapter that returns a scripted response per (model, system-prompt-key) lookup.
 * The system-prompt-key is the FIRST line of the system prompt, which is stable
 * per role and lets us differentiate cooperative-build / adversarial / defense /
 * synth without coupling to full prompt strings.
 */
type Script = Record<string, string | (() => string)>;

function makeFactory(script: Script): AdapterFactory {
  return (model: string): ModelAdapter => ({
    modelName: model,
    async generate(_prompt: string, system?: string): Promise<AdapterResult> {
      const key = `${model}::${(system ?? '').split('\n')[0] ?? ''}`;
      const fallbackKey = `*::${(system ?? '').split('\n')[0] ?? ''}`;
      const value = script[key] ?? script[fallbackKey];
      if (value === undefined) {
        throw new Error(`Test stub: no script entry for "${key}" or "${fallbackKey}"`);
      }
      return { content: typeof value === 'function' ? value() : value };
    },
  });
}

const ANY = '*';

describe('runIdeation — cooperative sub-mode', () => {
  it('runs cooperative-build + synth in collective style with sequential cooperative turns', async () => {
    const lineup = defaultLineup('cooperative');
    const factory = makeFactory({
      [`${ANY}::You are the Proposer in a cooperative product-ideation team.`]: 'P-turn',
      [`${ANY}::You are the Expander in a cooperative product-ideation team.`]: 'E-turn',
      [`${ANY}::You are the Pragmatist in a cooperative product-ideation team.`]: 'Pr-turn',
      [`${ANY}::You are the Lateralist in a cooperative product-ideation team.`]: 'L-turn',
      [`${ANY}::You are synthesizing a product-ideation transcript into a final ideation document.`]:
        'final synthesis',
    });
    const result = await runIdeation(
      {
        idea: 'A wearable that detects mood drift',
        mode: 'cooperative',
        style: 'collective',
        lineup,
        // Section 1: disable dedupe in legacy tests — it has its own coverage
        // in dedupe.test.ts + the dedupe-runs-by-default test below.
        dedupe: { enabled: false },
      },
      factory,
    );
    expect(result.status).toBe('complete');
    expect(result.error).toBeNull();
    expect(result.synthesis).toBe('final synthesis');
    expect(result.phases.map((p) => p.phase)).toEqual(['cooperative-build', 'synth']);
    expect(result.phases[0]!.style).toBe('collective');
    expect(result.phases[0]!.contributions).toHaveLength(4);
  });

  it('runs cooperative-build in individual style (parallel — agents see no peers)', async () => {
    const lineup = defaultLineup('cooperative');
    const factory = makeFactory({
      [`${ANY}::You are the Proposer in a cooperative product-ideation team.`]: 'P-turn',
      [`${ANY}::You are the Expander in a cooperative product-ideation team.`]: 'E-turn',
      [`${ANY}::You are the Pragmatist in a cooperative product-ideation team.`]: 'Pr-turn',
      [`${ANY}::You are the Lateralist in a cooperative product-ideation team.`]: 'L-turn',
      [`${ANY}::You are synthesizing a product-ideation transcript into a final ideation document.`]:
        'final',
    });
    const result = await runIdeation(
      {
        idea: 'idea',
        mode: 'cooperative',
        style: 'individual',
        lineup,
        dedupe: { enabled: false },
      },
      factory,
    );
    expect(result.status).toBe('complete');
    expect(result.phases[0]!.style).toBe('individual');
    expect(result.phases[0]!.contributions.map((c) => c.content)).toEqual([
      'P-turn',
      'E-turn',
      'Pr-turn',
      'L-turn',
    ]);
  });

  it('does NOT run adversarial or defense phases in cooperative sub-mode', async () => {
    const lineup = defaultLineup('cooperative');
    const factory = makeFactory({
      [`${ANY}::You are the Proposer in a cooperative product-ideation team.`]: 'P',
      [`${ANY}::You are the Expander in a cooperative product-ideation team.`]: 'E',
      [`${ANY}::You are the Pragmatist in a cooperative product-ideation team.`]: 'Pr',
      [`${ANY}::You are the Lateralist in a cooperative product-ideation team.`]: 'L',
      [`${ANY}::You are synthesizing a product-ideation transcript into a final ideation document.`]:
        'S',
    });
    const result = await runIdeation(
      {
        idea: 'i',
        mode: 'cooperative',
        style: 'collective',
        lineup,
        dedupe: { enabled: false },
      },
      factory,
    );
    expect(result.phases.find((p) => p.phase === 'adversarial-critique')).toBeUndefined();
    expect(result.phases.find((p) => p.phase === 'defense')).toBeUndefined();
  });
});

describe('runIdeation — adversarial sub-mode', () => {
  it('runs cooperative + adversarial + defense + synth', async () => {
    const lineup = defaultLineup('adversarial');
    const adversarialJson = JSON.stringify({
      problems: [
        { problem: 'no auth story', proposed_fix: 'add OAuth', dimension: 'technical' },
      ],
    });
    const defenseJson = JSON.stringify({
      defenses: [
        {
          critique_id: '0',
          stance: 'address',
          reasoning: 'The critique is valid and worth fixing.',
          draft_delta: 'Add OAuth support.',
        },
      ],
    });
    const factory = makeFactory({
      [`${ANY}::You are the Proposer in a cooperative product-ideation team.`]: 'P',
      [`${ANY}::You are the Expander in a cooperative product-ideation team.`]: 'E',
      [`${ANY}::You are the Pragmatist in a cooperative product-ideation team.`]: 'Pr',
      [`${ANY}::You are the Lateralist in a cooperative product-ideation team.`]: 'L',
      [`${ANY}::You are an adversarial reviewer evaluating a product idea. Your role is NOT to`]:
        adversarialJson,
      [`${ANY}::You are a cooperative author defending your product idea against structured critiques.`]:
        defenseJson,
      [`${ANY}::You are synthesizing a product-ideation transcript into a final ideation document.`]:
        'final',
    });
    const result = await runIdeation(
      {
        idea: 'i',
        mode: 'adversarial',
        style: 'collective',
        lineup,
        dedupe: { enabled: false },
      },
      factory,
    );
    expect(result.status).toBe('complete');
    expect(result.phases.map((p) => p.phase)).toEqual([
      'cooperative-build',
      'adversarial-critique',
      'defense',
      'synth',
    ]);
    // Adversarial team produced 2 contributions (skeptic + devils-advocate).
    const adv = result.phases.find((p) => p.phase === 'adversarial-critique')!;
    expect(adv.contributions).toHaveLength(2);
    expect(adv.contributions[0]!.problems).toEqual([
      { problem: 'no auth story', proposed_fix: 'add OAuth', dimension: 'technical' },
    ]);
    expect(adv.contributions[0]!.attempts).toBe(1);
  });

  it('skips defense phase when adversarial produces zero problems (well-formed but no problems)', async () => {
    // Empty problems[] returns null from parser (treated as malformed).
    // Use unstructured prose on both attempts so the orchestrator surfaces
    // unstructured contributions and finds no problems.
    const lineup = defaultLineup('adversarial');
    const factory = makeFactory({
      [`${ANY}::You are the Proposer in a cooperative product-ideation team.`]: 'P',
      [`${ANY}::You are the Expander in a cooperative product-ideation team.`]: 'E',
      [`${ANY}::You are the Pragmatist in a cooperative product-ideation team.`]: 'Pr',
      [`${ANY}::You are the Lateralist in a cooperative product-ideation team.`]: 'L',
      [`${ANY}::You are an adversarial reviewer evaluating a product idea. Your role is NOT to`]:
        'just prose, no JSON at all',
      [`${ANY}::You are synthesizing a product-ideation transcript into a final ideation document.`]:
        'final',
    });
    const result = await runIdeation(
      {
        idea: 'i',
        mode: 'adversarial',
        style: 'collective',
        lineup,
        dedupe: { enabled: false },
      },
      factory,
    );
    expect(result.status).toBe('complete');
    expect(result.phases.map((p) => p.phase)).toEqual([
      'cooperative-build',
      'adversarial-critique',
      'synth',
    ]);
    const adv = result.phases.find((p) => p.phase === 'adversarial-critique')!;
    expect(adv.warnings).toBeDefined();
    expect(adv.contributions[0]!.unstructured).toBe(true);
    expect(adv.contributions[0]!.attempts).toBe(2);
  });

  it('retries adversarial once when first attempt is malformed and second is valid', async () => {
    const lineup = defaultLineup('adversarial');
    let skepticCalls = 0;
    let daCalls = 0;
    const validJson = JSON.stringify({
      problems: [{ problem: 'X', proposed_fix: 'Y', dimension: 'technical' }],
    });
    const factory: AdapterFactory = (model: string) => ({
      modelName: model,
      async generate(_p, system?: string): Promise<AdapterResult> {
        const head = (system ?? '').split('\n')[0] ?? '';
        if (head.startsWith('You are the Proposer')) return { content: 'P' };
        if (head.startsWith('You are the Expander')) return { content: 'E' };
        if (head.startsWith('You are the Pragmatist')) return { content: 'Pr' };
        if (head.startsWith('You are the Lateralist')) return { content: 'L' };
        if (head.startsWith('You are an adversarial reviewer')) {
          // Skeptic uses Opus, Devils-Advocate uses GPT-5 — track each independently.
          if (model === 'anthropic/claude-opus-4-6') {
            skepticCalls++;
            // First attempt: malformed; second: valid.
            return skepticCalls === 1 ? { content: 'maybe' } : { content: validJson };
          }
          if (model === 'openai/gpt-5') {
            daCalls++;
            return { content: validJson }; // Always valid on first attempt.
          }
        }
        if (head.startsWith('You are a cooperative author defending your product idea')) {
          return {
            content: JSON.stringify({
              defenses: [
                {
                  critique_id: '0',
                  stance: 'address',
                  reasoning: 'Fix it.',
                  draft_delta: 'Updated draft.',
                },
              ],
            }),
          };
        }
        if (head.startsWith('You are synthesizing a product-ideation')) return { content: 'S' };
        throw new Error(`unexpected: ${head}`);
      },
    });
    const result = await runIdeation(
      {
        idea: 'i',
        mode: 'adversarial',
        style: 'collective',
        lineup,
        dedupe: { enabled: false },
      },
      factory,
    );
    expect(result.status).toBe('complete');
    expect(skepticCalls).toBe(2); // Retry happened.
    expect(daCalls).toBe(1); // No retry.
    const adv = result.phases.find((p) => p.phase === 'adversarial-critique')!;
    expect(adv.contributions[0]!.attempts).toBe(2);
    expect(adv.contributions[0]!.unstructured).toBeUndefined();
    expect(adv.contributions[1]!.attempts).toBe(1);
  });
});

describe('runIdeation — full sub-mode', () => {
  it('runs the full pipeline with the 8-model cooperative team', async () => {
    const lineup = defaultLineup('full');
    const adversarialJson = JSON.stringify({
      problems: [{ problem: 'p', proposed_fix: 'f', dimension: 'ux' }],
    });
    const defenseJson = JSON.stringify({
      defenses: [
        {
          critique_id: '0',
          stance: 'address',
          reasoning: 'The UX issue is valid.',
          draft_delta: 'Revise the UX flow.',
        },
      ],
    });
    const factory = makeFactory({
      [`${ANY}::You are the Proposer in a cooperative product-ideation team.`]: 'P',
      [`${ANY}::You are the Expander in a cooperative product-ideation team.`]: 'E',
      [`${ANY}::You are the Pragmatist in a cooperative product-ideation team.`]: 'Pr',
      [`${ANY}::You are the Lateralist in a cooperative product-ideation team.`]: 'L',
      [`${ANY}::You are an adversarial reviewer evaluating a product idea. Your role is NOT to`]:
        adversarialJson,
      [`${ANY}::You are a cooperative author defending your product idea against structured critiques.`]:
        defenseJson,
      [`${ANY}::You are synthesizing a product-ideation transcript into a final ideation document.`]:
        'final',
    });
    const result = await runIdeation(
      {
        idea: 'i',
        mode: 'full',
        style: 'collective',
        lineup,
        dedupe: { enabled: false },
      },
      factory,
    );
    expect(result.status).toBe('complete');
    expect(result.phases.find((p) => p.phase === 'cooperative-build')!.contributions).toHaveLength(8);
    expect(result.phases.find((p) => p.phase === 'defense')!.contributions).toHaveLength(8);
    expect(result.synthesis).toBe('final');
  });
});

describe('runIdeation — error handling', () => {
  it('captures provider errors and persists partial phases', async () => {
    const lineup = defaultLineup('cooperative');
    const factory: AdapterFactory = (model: string) => ({
      modelName: model,
      async generate(_p, system?: string): Promise<AdapterResult> {
        const head = (system ?? '').split('\n')[0] ?? '';
        if (head.startsWith('You are the Proposer')) return { content: 'P' };
        if (head.startsWith('You are the Expander')) {
          throw new Error('upstream timeout');
        }
        return { content: 'x' };
      },
    });
    const result = await runIdeation(
      {
        idea: 'i',
        mode: 'cooperative',
        style: 'collective',
        lineup,
        dedupe: { enabled: false },
      },
      factory,
    );
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/upstream timeout/);
    // No completed phases (cooperative-build aborted before yielding a record).
    expect(result.phases).toHaveLength(0);
  });
});

describe('runIdeation — dedupe phase wiring (Section 1)', () => {
  it('runs dedupe by default between cooperative-build and synth, with stub embedder', async () => {
    const lineup = defaultLineup('cooperative');
    const factory = makeFactory({
      [`${ANY}::You are the Proposer in a cooperative product-ideation team.`]: 'P-turn',
      [`${ANY}::You are the Expander in a cooperative product-ideation team.`]: 'E-turn',
      [`${ANY}::You are the Pragmatist in a cooperative product-ideation team.`]: 'Pr-turn',
      [`${ANY}::You are the Lateralist in a cooperative product-ideation team.`]: 'L-turn',
      [`${ANY}::You are synthesizing a product-ideation transcript into a final ideation document.`]:
        'synth',
    });
    // Stub embedder: orthogonal vectors for each draft → no collapses, but
    // the dedupe phase still records itself with provider='local'.
    const result = await runIdeation(
      {
        idea: 'i',
        mode: 'cooperative',
        style: 'collective',
        lineup,
        dedupe: {
          embedder: async (_provider, texts) =>
            texts.map((_t, i) => {
              const v = new Array(8).fill(0) as number[];
              v[i] = 1;
              return v;
            }),
        },
      },
      factory,
    );
    expect(result.status).toBe('complete');
    expect(result.phases.map((p) => p.phase)).toEqual([
      'cooperative-build',
      'dedupe',
      'synth',
    ]);
    const dedupe = result.phases.find((p) => p.phase === 'dedupe')!;
    expect(dedupe.dedupe).toBeDefined();
    expect(dedupe.dedupe!.provider).toBe('local');
    expect(dedupe.dedupe!.skipped).toBe(false);
    expect(dedupe.dedupe!.threshold).toBe(0.85);
    // Orthogonal vectors → all 4 drafts kept.
    expect(dedupe.contributions).toHaveLength(4);
    expect(dedupe.dedupe!.merged_into).toEqual({});
  });

  it('collapses duplicate drafts before synth so synth sees only survivors', async () => {
    const lineup = defaultLineup('cooperative');
    let synthSawTurns: readonly string[] = [];
    const factory: AdapterFactory = (model: string) => ({
      modelName: model,
      async generate(prompt: string, system?: string): Promise<AdapterResult> {
        const head = (system ?? '').split('\n')[0] ?? '';
        if (head.startsWith('You are the Proposer')) return { content: 'identical' };
        if (head.startsWith('You are the Expander')) return { content: 'identical' };
        if (head.startsWith('You are the Pragmatist')) return { content: 'identical' };
        if (head.startsWith('You are the Lateralist')) return { content: 'identical' };
        if (head.startsWith('You are synthesizing')) {
          // Capture the cooperative-turn count that the synth prompt was built from.
          // Cooperative turns appear as lines in the prompt — count occurrences
          // of the duplicate text.
          synthSawTurns = prompt.split('\n').filter((l) => l.includes('identical'));
          return { content: 'synth' };
        }
        throw new Error(`unexpected: ${head}`);
      },
    });
    const result = await runIdeation(
      {
        idea: 'i',
        mode: 'cooperative',
        style: 'collective',
        lineup,
        dedupe: {
          // All identical → all collapse to a single survivor.
          embedder: async (_p, texts) => texts.map(() => [1, 0, 0]),
        },
      },
      factory,
    );
    expect(result.status).toBe('complete');
    const dedupe = result.phases.find((p) => p.phase === 'dedupe')!;
    expect(dedupe.contributions).toHaveLength(1);
    // Synth received only the surviving (deduped) drafts. Original 4 collapsed → 1.
    expect(synthSawTurns.length).toBe(1);
  });

  it('soft-fails when both providers error: skips dedupe, surfaces warning, drafts pass through', async () => {
    const lineup = defaultLineup('cooperative');
    const factory = makeFactory({
      [`${ANY}::You are the Proposer in a cooperative product-ideation team.`]: 'P',
      [`${ANY}::You are the Expander in a cooperative product-ideation team.`]: 'E',
      [`${ANY}::You are the Pragmatist in a cooperative product-ideation team.`]: 'Pr',
      [`${ANY}::You are the Lateralist in a cooperative product-ideation team.`]: 'L',
      [`${ANY}::You are synthesizing a product-ideation transcript into a final ideation document.`]:
        'S',
    });
    const result = await runIdeation(
      {
        idea: 'i',
        mode: 'cooperative',
        style: 'collective',
        lineup,
        dedupe: {
          embedder: async () => {
            throw new Error('provider down');
          },
        },
      },
      factory,
    );
    expect(result.status).toBe('complete');
    const dedupe = result.phases.find((p) => p.phase === 'dedupe')!;
    expect(dedupe.dedupe!.skipped).toBe(true);
    expect(dedupe.dedupe!.provider).toBeNull();
    expect(dedupe.warnings).toBeDefined();
    expect(dedupe.warnings![0]).toMatch(/provider down/);
    // Drafts pass through untouched on skip.
    expect(dedupe.contributions).toHaveLength(4);
  });

  it('dedupe.enabled === false skips the phase entirely (no record on phases[])', async () => {
    const lineup = defaultLineup('cooperative');
    const factory = makeFactory({
      [`${ANY}::You are the Proposer in a cooperative product-ideation team.`]: 'P',
      [`${ANY}::You are the Expander in a cooperative product-ideation team.`]: 'E',
      [`${ANY}::You are the Pragmatist in a cooperative product-ideation team.`]: 'Pr',
      [`${ANY}::You are the Lateralist in a cooperative product-ideation team.`]: 'L',
      [`${ANY}::You are synthesizing a product-ideation transcript into a final ideation document.`]:
        'S',
    });
    const result = await runIdeation(
      {
        idea: 'i',
        mode: 'cooperative',
        style: 'collective',
        lineup,
        dedupe: { enabled: false },
      },
      factory,
    );
    expect(result.phases.find((p) => p.phase === 'dedupe')).toBeUndefined();
  });
});
