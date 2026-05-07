import { describe, expect, it } from 'vitest';
import type { ModelAdapter, AdapterResult } from '../../adapters/base.js';
import { defaultLineup } from '../lineup.js';
import { runIdeation, type AdapterFactory } from '../orchestrator.js';

/**
 * Test adapter that returns a scripted response per (model, system-prompt-key) lookup.
 * The system-prompt-key is the FIRST line of the system prompt, which is stable
 * per role and lets us differentiate cooperative-build / adversarial / rebuttal /
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
      { idea: 'A wearable that detects mood drift', mode: 'cooperative', style: 'collective', lineup },
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
      { idea: 'idea', mode: 'cooperative', style: 'individual', lineup },
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

  it('does NOT run adversarial or rebuttal phases in cooperative sub-mode', async () => {
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
      { idea: 'i', mode: 'cooperative', style: 'collective', lineup },
      factory,
    );
    expect(result.phases.find((p) => p.phase === 'adversarial-critique')).toBeUndefined();
    expect(result.phases.find((p) => p.phase === 'rebuttal-1')).toBeUndefined();
    expect(result.phases.find((p) => p.phase === 'rebuttal-2')).toBeUndefined();
  });
});

describe('runIdeation — adversarial sub-mode', () => {
  it('runs cooperative + adversarial + rebuttal-1 + rebuttal-2 + synth (rebuttal cap is hard)', async () => {
    const lineup = defaultLineup('adversarial');
    const adversarialJson = JSON.stringify({
      problems: [{ problem: 'no auth story', proposed_fix: 'add OAuth' }],
    });
    const factory = makeFactory({
      [`${ANY}::You are the Proposer in a cooperative product-ideation team.`]: 'P',
      [`${ANY}::You are the Expander in a cooperative product-ideation team.`]: 'E',
      [`${ANY}::You are the Pragmatist in a cooperative product-ideation team.`]: 'Pr',
      [`${ANY}::You are the Lateralist in a cooperative product-ideation team.`]: 'L',
      [`${ANY}::You are an adversarial reviewer evaluating a product idea. Your role is NOT to`]:
        adversarialJson,
      [`${ANY}::You are responding to adversarial critique of the team's product idea.`]: 'rebuttal',
      [`${ANY}::You are synthesizing a product-ideation transcript into a final ideation document.`]:
        'final',
    });
    const result = await runIdeation(
      { idea: 'i', mode: 'adversarial', style: 'collective', lineup },
      factory,
    );
    expect(result.status).toBe('complete');
    expect(result.phases.map((p) => p.phase)).toEqual([
      'cooperative-build',
      'adversarial-critique',
      'rebuttal-1',
      'rebuttal-2',
      'synth',
    ]);
    // Adversarial team produced 2 contributions (skeptic + devils-advocate).
    const adv = result.phases.find((p) => p.phase === 'adversarial-critique')!;
    expect(adv.contributions).toHaveLength(2);
    expect(adv.contributions[0]!.problems).toEqual([
      { problem: 'no auth story', proposed_fix: 'add OAuth' },
    ]);
    expect(adv.contributions[0]!.attempts).toBe(1);
  });

  it('skips rebuttal phases when adversarial produces zero problems (well-formed but no problems)', async () => {
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
      { idea: 'i', mode: 'adversarial', style: 'collective', lineup },
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
      problems: [{ problem: 'X', proposed_fix: 'Y' }],
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
        if (head.startsWith('You are responding to adversarial critique')) return { content: 'r' };
        if (head.startsWith('You are synthesizing a product-ideation')) return { content: 'S' };
        throw new Error(`unexpected: ${head}`);
      },
    });
    const result = await runIdeation(
      { idea: 'i', mode: 'adversarial', style: 'collective', lineup },
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
      problems: [{ problem: 'p', proposed_fix: 'f' }],
    });
    const factory = makeFactory({
      [`${ANY}::You are the Proposer in a cooperative product-ideation team.`]: 'P',
      [`${ANY}::You are the Expander in a cooperative product-ideation team.`]: 'E',
      [`${ANY}::You are the Pragmatist in a cooperative product-ideation team.`]: 'Pr',
      [`${ANY}::You are the Lateralist in a cooperative product-ideation team.`]: 'L',
      [`${ANY}::You are an adversarial reviewer evaluating a product idea. Your role is NOT to`]:
        adversarialJson,
      [`${ANY}::You are responding to adversarial critique of the team's product idea.`]: 'r',
      [`${ANY}::You are synthesizing a product-ideation transcript into a final ideation document.`]:
        'final',
    });
    const result = await runIdeation(
      { idea: 'i', mode: 'full', style: 'collective', lineup },
      factory,
    );
    expect(result.status).toBe('complete');
    expect(result.phases.find((p) => p.phase === 'cooperative-build')!.contributions).toHaveLength(8);
    expect(result.phases.find((p) => p.phase === 'rebuttal-1')!.contributions).toHaveLength(8);
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
      { idea: 'i', mode: 'cooperative', style: 'collective', lineup },
      factory,
    );
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/upstream timeout/);
    // No completed phases (cooperative-build aborted before yielding a record).
    expect(result.phases).toHaveLength(0);
  });
});
