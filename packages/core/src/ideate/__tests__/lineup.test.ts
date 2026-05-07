import { describe, expect, it } from 'vitest';
import {
  CLOSED_MODELS,
  OPEN_MODELS,
  SYNTH_DEFAULTS,
  defaultLineup,
  resolveLineup,
} from '../lineup.js';

describe('defaultLineup', () => {
  it('cooperative defaults to the 4 closed models with no adversarial team', () => {
    const r = defaultLineup('cooperative');
    expect(r.mode).toBe('cooperative');
    expect(r.synth).toBe(CLOSED_MODELS.opus);
    expect(r.team.cooperative).toHaveLength(4);
    expect(r.team.cooperative.map((s) => s.model)).toEqual([
      CLOSED_MODELS.opus,
      CLOSED_MODELS.sonnet,
      CLOSED_MODELS.gpt5,
      CLOSED_MODELS.gemini,
    ]);
    expect(r.team.adversarial).toHaveLength(0);
  });

  it('adversarial keeps the 4 closed cooperative team and adds a 2-agent adversarial team', () => {
    const r = defaultLineup('adversarial');
    expect(r.synth).toBe(CLOSED_MODELS.opus);
    expect(r.team.cooperative).toHaveLength(4);
    expect(r.team.adversarial.map((s) => s.role)).toEqual(['skeptic', 'devils-advocate']);
  });

  it('full uses all 8 models on the cooperative side and Gemini for synth', () => {
    const r = defaultLineup('full');
    expect(r.synth).toBe('google/gemini-2.5-pro');
    expect(r.team.cooperative).toHaveLength(8);
    const models = r.team.cooperative.map((s) => s.model);
    expect(models).toContain(CLOSED_MODELS.opus);
    expect(models).toContain(CLOSED_MODELS.sonnet);
    expect(models).toContain(CLOSED_MODELS.gpt5);
    expect(models).toContain(CLOSED_MODELS.gemini);
    expect(models).toContain(OPEN_MODELS.qwen);
    expect(models).toContain(OPEN_MODELS.deepseek);
    expect(models).toContain(OPEN_MODELS.mistral);
    expect(models).toContain(OPEN_MODELS.nemotron);
    expect(r.team.adversarial).toHaveLength(2);
  });

  it('synth defaults match the spec: Opus 4.6 for cooperative+adversarial, Gemini for full', () => {
    expect(SYNTH_DEFAULTS.cooperative).toBe(CLOSED_MODELS.opus);
    expect(SYNTH_DEFAULTS.adversarial).toBe(CLOSED_MODELS.opus);
    expect(SYNTH_DEFAULTS.full).toBe('google/gemini-2.5-pro');
  });
});

describe('resolveLineup', () => {
  it('returns the in-code defaults exactly when no overrides are supplied', () => {
    expect(resolveLineup('cooperative')).toEqual(defaultLineup('cooperative'));
    expect(resolveLineup('adversarial')).toEqual(defaultLineup('adversarial'));
    expect(resolveLineup('full')).toEqual(defaultLineup('full'));
  });

  it('per-role override replaces only that role and leaves siblings on the default', () => {
    const r = resolveLineup('cooperative', {
      lineup: { cooperative: { proposer: 'custom/proposer-v1' } },
    });
    expect(r.team.cooperative[0]).toEqual({ role: 'proposer', model: 'custom/proposer-v1' });
    expect(r.team.cooperative[1]?.model).toBe(CLOSED_MODELS.sonnet);
    expect(r.team.cooperative[2]?.model).toBe(CLOSED_MODELS.gpt5);
    expect(r.team.cooperative[3]?.model).toBe(CLOSED_MODELS.gemini);
  });

  it('adversarial role overrides land on the adversarial team only', () => {
    const r = resolveLineup('adversarial', {
      lineup: { adversarial: { skeptic: 'custom/skeptic-v1' } },
    });
    expect(r.team.adversarial[0]).toEqual({ role: 'skeptic', model: 'custom/skeptic-v1' });
    expect(r.team.adversarial[1]?.model).toBe(CLOSED_MODELS.gpt5);
    // Cooperative team is untouched.
    expect(r.team.cooperative[0]?.model).toBe(CLOSED_MODELS.opus);
  });

  it('synth override per sub-mode replaces the synth model only', () => {
    const r = resolveLineup('full', { synth: { full: CLOSED_MODELS.opus } });
    expect(r.synth).toBe(CLOSED_MODELS.opus);
    // Team is unaffected.
    expect(r.team.cooperative).toHaveLength(8);
  });

  it('cooperative overrides on full mode replace only the FIRST same-role slot (closed side)', () => {
    const r = resolveLineup('full', {
      lineup: { full: { proposer: 'custom/proposer-v1' } },
    });
    // First proposer slot is closed (Opus); override lands here.
    expect(r.team.cooperative[0]).toEqual({ role: 'proposer', model: 'custom/proposer-v1' });
    // Second proposer slot is open (Qwen); stays on default.
    expect(r.team.cooperative[4]?.model).toBe(OPEN_MODELS.qwen);
  });

  it('rejects unknown role overrides', () => {
    expect(() =>
      resolveLineup('cooperative', {
        lineup: { cooperative: { ['mediator' as never]: 'x/y' } },
      }),
    ).toThrow(/unknown role "mediator"/);
  });

  it('rejects adversarial-role overrides under cooperative sub-mode', () => {
    expect(() =>
      resolveLineup('cooperative', {
        lineup: { cooperative: { skeptic: 'x/y' } },
      }),
    ).toThrow(/adversarial-only/);
  });

  it('does NOT merge overrides — missing roles fall back to defaults verbatim', () => {
    const r = resolveLineup('adversarial', {
      lineup: { adversarial: { 'devils-advocate': 'custom/da-v1' } },
    });
    // Skeptic stays on default; devils-advocate is replaced.
    expect(r.team.adversarial[0]?.model).toBe(CLOSED_MODELS.opus);
    expect(r.team.adversarial[1]?.model).toBe('custom/da-v1');
  });
});
