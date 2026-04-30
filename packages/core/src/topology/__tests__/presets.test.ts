import { describe, it, expect } from 'vitest';
import { parse } from 'smol-toml';
import {
  loadTopology,
  BUILTIN_PRESETS,
  BUILTIN_PRESET_IDS,
  isBuiltinPreset,
  type TopologyPreset,
} from '../index.js';

/**
 * Helper: parse TOML and resolve through the loader. The loader is the only
 * supported entry point for resolving an active preset, so these tests go
 * through it rather than reaching into BUILTIN_PRESETS directly.
 */
function load(toml: string) {
  return loadTopology(parse(toml));
}

/**
 * Specs for the six Stage 1 built-in presets. Each entry is the contract the
 * preset registry MUST satisfy:
 *   - `id`: kebab-case key used in `parliament.toml`
 *   - `name`: human display name
 *   - `expectedSteps`: ordered list of step IDs (which equal the neurotype
 *     IDs for built-ins). Synthesizer/Sentry/RedAgent are NEVER in this list
 *     because they are structural infrastructure, not steppable neurotypes.
 *
 * If you add a built-in preset, append it here AND to BUILTIN_PRESETS.
 */
const PRESET_SPECS: ReadonlyArray<{
  id: string;
  name: string;
  expectedSteps: readonly string[];
}> = [
  { id: 'debate', name: 'Debate', expectedSteps: ['proposer', 'skeptic'] },
  {
    id: 'star-chamber',
    name: 'Star Chamber',
    expectedSteps: ['proposer', 'skeptic', 'devils-advocate', 'empiricist'],
  },
  {
    id: 'chain-of-verifiers',
    name: 'Chain-of-Verifiers',
    expectedSteps: ['proposer', 'empiricist', 'steelmanner', 'skeptic'],
  },
  {
    id: 'socratic',
    name: 'Socratic',
    expectedSteps: ['translator', 'empiricist', 'skeptic'],
  },
  {
    id: 'long-view',
    name: 'Long-View',
    expectedSteps: ['historian', 'proposer', 'forecaster', 'pragmatist'],
  },
  {
    id: 'reframe',
    name: 'Reframe',
    expectedSteps: ['lateralist', 'translator', 'steelmanner'],
  },
];

describe('built-in preset registry', () => {
  it('registers exactly the six Stage 1 presets', () => {
    expect(new Set(BUILTIN_PRESET_IDS)).toEqual(new Set(PRESET_SPECS.map((p) => p.id)));
  });

  it.each(PRESET_SPECS)(
    'registers "$id" with all required metadata fields',
    ({ id, name }) => {
      const preset = BUILTIN_PRESETS[id];
      expect(preset).toBeDefined();
      const p = preset as TopologyPreset;
      expect(p.id).toBe(id);
      expect(p.name).toBe(name);
      // description and best_for are required uniformly per the topology spec.
      expect(typeof p.description).toBe('string');
      expect(p.description.length).toBeGreaterThan(0);
      expect(typeof p.best_for).toBe('string');
      expect(p.best_for.length).toBeGreaterThan(0);
      expect(p.isBuiltin).toBe(true);
      expect(isBuiltinPreset(id)).toBe(true);
    },
  );

  it.each(PRESET_SPECS)(
    'declares "$id" steps in the expected order with no synthesizer/red-agent/sentry leakage',
    ({ id, expectedSteps }) => {
      const preset = BUILTIN_PRESETS[id] as TopologyPreset;
      expect(preset.steps.map((s) => s.id)).toEqual(expectedSteps);
      expect(preset.steps.map((s) => s.neurotype)).toEqual(expectedSteps);
      // Every step strict-by-default — no opt-in skipping in the built-ins.
      for (const step of preset.steps) {
        expect(step.optional).toBe(false);
      }
      // Structural infrastructure must never appear in steps.
      const stepNeurotypes = new Set(preset.steps.map((s) => s.neurotype));
      expect(stepNeurotypes.has('synthesizer')).toBe(false);
      expect(stepNeurotypes.has('red-agent')).toBe(false);
      expect(stepNeurotypes.has('sentry')).toBe(false);
    },
  );
});

describe('built-in presets resolve through the loader', () => {
  it.each(PRESET_SPECS)(
    'resolves "$id" as the active preset when set in [topology].active',
    ({ id, name, expectedSteps }) => {
      const config = load(`
[topology]
active = "${id}"
`);
      expect(config.activePreset.id).toBe(id);
      expect(config.activePreset.name).toBe(name);
      expect(config.activePreset.isBuiltin).toBe(true);
      expect(config.activePreset.steps.map((s) => s.id)).toEqual(expectedSteps);
    },
  );

  it('resolves "debate" as the default when [topology] is absent', () => {
    const config = load(``);
    expect(config.activePreset.id).toBe('debate');
    expect(config.activePreset.isBuiltin).toBe(true);
  });

  it('exposes all six built-ins under config.presets even when only one is active', () => {
    const config = load(`
[topology]
active = "debate"
`);
    for (const { id } of PRESET_SPECS) {
      expect(config.presets[id]).toBeDefined();
      expect(config.presets[id]!.isBuiltin).toBe(true);
    }
  });
});

describe('Socratic preset shape (AC: no Proposer required)', () => {
  it('does not include a "proposer" step', () => {
    const preset = BUILTIN_PRESETS['socratic'] as TopologyPreset;
    expect(preset.steps.map((s) => s.id)).not.toContain('proposer');
  });

  it('opens with translator (assumption-surfacing) per the topology spec', () => {
    const preset = BUILTIN_PRESETS['socratic'] as TopologyPreset;
    expect(preset.steps[0]!.neurotype).toBe('translator');
  });
});
