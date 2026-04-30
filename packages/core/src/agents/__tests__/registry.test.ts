import { describe, it, expect, vi } from 'vitest';
import type { ModelAdapter } from '../../adapters/base.js';
import type { Blackboard } from '../../types.js';
import {
  BUILTIN_AGENT_REGISTRY,
  BUILTIN_AGENT_IDS,
  createBuiltinAgent,
  isBuiltinNeurotype,
} from '../registry.js';

const KEBAB_CASE = /^[a-z][a-z0-9-]*$/;

const STAGE_1_NEUROTYPES = [
  'historian',
  'forecaster',
  'pragmatist',
  'empiricist',
  'steelmanner',
  'devils-advocate',
  'lateralist',
  'translator',
] as const;

function makeAdapter(): ModelAdapter {
  return { modelName: 'test-model', generate: vi.fn().mockResolvedValue('') };
}

function makeBlackboard(): Blackboard {
  return { topic: 'unused', turns: [], conflicts: [], metadata: {} };
}

describe('built-in agent registry', () => {
  it('registers the eight Stage 1 neurotypes', () => {
    for (const id of STAGE_1_NEUROTYPES) {
      expect(BUILTIN_AGENT_REGISTRY).toHaveProperty(id);
      expect(isBuiltinNeurotype(id)).toBe(true);
    }
  });

  it('keeps the original Proposer and Skeptic IDs alongside the new ones', () => {
    expect(isBuiltinNeurotype('proposer')).toBe(true);
    expect(isBuiltinNeurotype('skeptic')).toBe(true);
  });

  it('uses kebab-case for every registered ID', () => {
    for (const id of BUILTIN_AGENT_IDS) {
      expect(id).toMatch(KEBAB_CASE);
    }
  });

  it('does NOT register Sentry or Synthesizer (they are infrastructure, not steppable neurotypes)', () => {
    expect(isBuiltinNeurotype('sentry')).toBe(false);
    expect(isBuiltinNeurotype('synthesizer')).toBe(false);
  });

  it('createBuiltinAgent throws on unknown IDs and lists the known ones', () => {
    expect(() => createBuiltinAgent('nope', makeAdapter())).toThrow(/Unknown built-in neurotype "nope"/);
    expect(() => createBuiltinAgent('nope', makeAdapter())).toThrow(/historian/);
  });

  it('every Stage 1 stub returns a placeholder marker without calling the adapter', async () => {
    for (const id of STAGE_1_NEUROTYPES) {
      const adapter = makeAdapter();
      const agent = createBuiltinAgent(id, adapter);
      const result = await agent.generate(makeBlackboard());
      expect(result.truncated).toBe(false);
      expect(result.content).toMatch(/stub.*implementation pending/i);
      expect(adapter.generate).not.toHaveBeenCalled();
    }
  });

  it('every Stage 1 stub reports its neurotype ID matching its registry key', () => {
    // The pre-existing Proposer / Skeptic agents use legacy mood-style
    // neurotype labels (`'structured'`, `'critical'`) for backward
    // compatibility with the original Debate engine; aligning those is the
    // topology-runtime task's job, not this scaffold's. The new Stage 1
    // agents MUST report kebab-case IDs that match the registry key.
    for (const id of STAGE_1_NEUROTYPES) {
      const agent = createBuiltinAgent(id, makeAdapter());
      expect(agent.neurotype).toBe(id);
    }
  });
});
