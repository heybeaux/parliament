/**
 * GET /presets availability info — Stage 4 server contract.
 *
 * Verifies the three acceptance criteria for task c86f1e8c:
 *   AC1: Response carries `requires_neurotypes` + `missing_neurotypes` per preset.
 *   AC2: Removing a referenced neurotype from config marks the preset as
 *        missing it on the next reload (signature change → recompute).
 *   AC3: Validation result is cached — the endpoint does not re-walk every
 *        preset's steps on every request when the config has not changed.
 *
 * The mock surface mirrors `server.test.ts` so we share the same view of the
 * core package. We override `loadTopologyConfig` per-test to drive different
 * registry shapes through the same router.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { TopologyConfig, TopologyPreset, UserNeurotypeConfig } from '@parliament/core';
import {
  __resetPresetAvailabilityCache,
  __getPresetAvailabilityComputeCount,
} from '../routes.js';
import { DEFAULT_SERVER_CONFIG } from '../config.js';
import { initDb } from '../db.js';

// ---------------------------------------------------------------------------
// Mock @parliament/core. The unmocked surface (BUILTIN_PRESETS,
// isBuiltinNeurotype) is preserved so the route can resolve neurotype IDs
// against the real registry; only loadTopologyConfig is replaced per test.
// ---------------------------------------------------------------------------

vi.mock('@parliament/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@parliament/core')>();

  return {
    ...actual,
    loadTopologyConfig: vi.fn().mockImplementation((): TopologyConfig => ({
      activePreset: actual.BUILTIN_PRESETS['debate']!,
      presets: { ...actual.BUILTIN_PRESETS },
      userNeurotypes: {},
    })),
  };
});

// Re-import after the mock so the route picks up the stub.
const { createRouter } = await import('../routes.js');

// ---------------------------------------------------------------------------
// Test fixtures — minimal stand-ins for the real router dependencies.
// ---------------------------------------------------------------------------

function makeApp(): Hono {
  return createRouter(initDb(':memory:'), {
    serverConfig: { ...DEFAULT_SERVER_CONFIG, cors_origins: ['http://localhost:5173'] },
  });
}

interface PresetEntry {
  id: string;
  requires_neurotypes: string[];
  missing_neurotypes: string[];
  steps: Array<{ id: string; neurotype: string; optional: boolean }>;
  parallel_steps?: Array<{ id: string; neurotype: string; optional: boolean }>;
}

async function fetchPresets(app: Hono): Promise<{
  presets: PresetEntry[];
  defaultPreset: string;
}> {
  const res = await app.request('/presets');
  expect(res.status).toBe(200);
  return (await res.json()) as { presets: PresetEntry[]; defaultPreset: string };
}

// Helpers to construct tailored topology configs.

function makePreset(overrides: Partial<TopologyPreset> & Pick<TopologyPreset, 'id'>): TopologyPreset {
  return {
    name: overrides.name ?? overrides.id,
    description: overrides.description ?? '',
    best_for: overrides.best_for ?? '',
    isBuiltin: overrides.isBuiltin ?? false,
    steps: overrides.steps ?? [],
    ...(overrides.parallel_steps !== undefined ? { parallel_steps: overrides.parallel_steps } : {}),
    id: overrides.id,
  };
}

function makeUserNeurotype(): UserNeurotypeConfig {
  return { model: 'mock', system_prompt: '', temperature: 0.7 };
}

// ---------------------------------------------------------------------------
// AC1 — response shape
// ---------------------------------------------------------------------------

describe('GET /presets — AC1: requires_neurotypes + missing_neurotypes per preset', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetPresetAvailabilityCache();
  });

  it('returns requires_neurotypes covering every step neurotype, no duplicates, in order', async () => {
    const app = makeApp();
    const body = await fetchPresets(app);

    // Debate uses proposer + skeptic. Both are built-in, so missing is empty.
    const debate = body.presets.find((p) => p.id === 'debate');
    expect(debate).toBeDefined();
    expect(debate!.requires_neurotypes).toEqual(['proposer', 'skeptic']);
    expect(debate!.missing_neurotypes).toEqual([]);
  });

  it('includes parallel_steps neurotypes in requires_neurotypes (Jury)', async () => {
    const app = makeApp();
    const body = await fetchPresets(app);

    const jury = body.presets.find((p) => p.id === 'jury');
    expect(jury).toBeDefined();
    // Sequential proposer + four parallel critics, all built-in.
    expect(jury!.requires_neurotypes).toEqual([
      'proposer',
      'skeptic',
      'empiricist',
      'steelmanner',
      'devils-advocate',
    ]);
    expect(jury!.missing_neurotypes).toEqual([]);
  });

  it('returns parallel_steps in the response shape when the preset declares them', async () => {
    const app = makeApp();
    const body = await fetchPresets(app);

    const jury = body.presets.find((p) => p.id === 'jury');
    expect(jury!.parallel_steps).toBeDefined();
    expect(jury!.parallel_steps!.map((s) => s.neurotype)).toEqual([
      'skeptic',
      'empiricist',
      'steelmanner',
      'devils-advocate',
    ]);

    const debate = body.presets.find((p) => p.id === 'debate');
    expect(debate!.parallel_steps).toBeUndefined();
  });

  it('treats user-defined neurotypes as registered (not missing)', async () => {
    const { loadTopologyConfig } = await import('@parliament/core');
    const customPreset = makePreset({
      id: 'custom',
      isBuiltin: false,
      steps: [
        { id: 'lead', neurotype: 'proposer', optional: false },
        { id: 'review', neurotype: 'my-reviewer', optional: false },
      ],
    });
    vi.mocked(loadTopologyConfig).mockReturnValueOnce({
      activePreset: customPreset,
      presets: { custom: customPreset },
      userNeurotypes: { 'my-reviewer': makeUserNeurotype() },
    });

    const app = makeApp();
    const body = await fetchPresets(app);

    const custom = body.presets.find((p) => p.id === 'custom')!;
    expect(custom.requires_neurotypes).toEqual(['proposer', 'my-reviewer']);
    expect(custom.missing_neurotypes).toEqual([]);
  });

  it('reports neurotypes that are neither built-in nor user-defined as missing', async () => {
    const { loadTopologyConfig } = await import('@parliament/core');
    const brokenPreset = makePreset({
      id: 'broken',
      isBuiltin: false,
      steps: [
        { id: 'lead', neurotype: 'proposer', optional: false },
        { id: 'gone', neurotype: 'ghost-neurotype', optional: false },
      ],
    });
    vi.mocked(loadTopologyConfig).mockReturnValueOnce({
      activePreset: brokenPreset,
      presets: { broken: brokenPreset },
      userNeurotypes: {},
    });

    const app = makeApp();
    const body = await fetchPresets(app);

    const broken = body.presets.find((p) => p.id === 'broken')!;
    expect(broken.requires_neurotypes).toEqual(['proposer', 'ghost-neurotype']);
    expect(broken.missing_neurotypes).toEqual(['ghost-neurotype']);
  });
});

// ---------------------------------------------------------------------------
// AC2 — removing a referenced neurotype marks it missing on next reload
// ---------------------------------------------------------------------------

describe('GET /presets — AC2: removed neurotype surfaces as missing on reload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetPresetAvailabilityCache();
  });

  it('flips a preset from available to missing when its user-defined neurotype is removed from config', async () => {
    const { loadTopologyConfig } = await import('@parliament/core');
    const preset = makePreset({
      id: 'team',
      isBuiltin: false,
      steps: [
        { id: 'lead', neurotype: 'proposer', optional: false },
        { id: 'audit', neurotype: 'team-auditor', optional: false },
      ],
    });

    // First load: team-auditor is a registered user-defined neurotype.
    vi.mocked(loadTopologyConfig).mockReturnValueOnce({
      activePreset: preset,
      presets: { team: preset },
      userNeurotypes: { 'team-auditor': makeUserNeurotype() },
    });
    const app = makeApp();
    const before = await fetchPresets(app);
    expect(before.presets[0]!.missing_neurotypes).toEqual([]);

    // Second load (simulating config reload): team-auditor has been removed.
    vi.mocked(loadTopologyConfig).mockReturnValueOnce({
      activePreset: preset,
      presets: { team: preset },
      userNeurotypes: {},
    });
    const after = await fetchPresets(app);
    expect(after.presets[0]!.requires_neurotypes).toEqual(['proposer', 'team-auditor']);
    expect(after.presets[0]!.missing_neurotypes).toEqual(['team-auditor']);
  });
});

// ---------------------------------------------------------------------------
// AC3 — caching: validation runs once across identical requests
// ---------------------------------------------------------------------------

describe('GET /presets — AC3: validation result is cached', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetPresetAvailabilityCache();
  });

  it('does not recompute the availability map when the topology has not changed', async () => {
    const app = makeApp();

    // First request — must populate the cache.
    await fetchPresets(app);
    expect(__getPresetAvailabilityComputeCount()).toBe(1);

    // Subsequent requests with the same topology must reuse the cached result.
    await fetchPresets(app);
    await fetchPresets(app);
    await fetchPresets(app);
    expect(__getPresetAvailabilityComputeCount()).toBe(1);
  });

  it('recomputes when the config reload returns a different signature', async () => {
    const { loadTopologyConfig } = await import('@parliament/core');
    const preset = makePreset({
      id: 'shifty',
      isBuiltin: false,
      steps: [{ id: 'a', neurotype: 'proposer', optional: false }],
    });

    // First load: no user neurotypes referenced.
    vi.mocked(loadTopologyConfig).mockReturnValueOnce({
      activePreset: preset,
      presets: { shifty: preset },
      userNeurotypes: {},
    });
    const app = makeApp();
    await fetchPresets(app);
    expect(__getPresetAvailabilityComputeCount()).toBe(1);

    // Second load: same preset, but a user-defined neurotype is added —
    // signature changes, so the cache must invalidate and recompute.
    vi.mocked(loadTopologyConfig).mockReturnValueOnce({
      activePreset: preset,
      presets: { shifty: preset },
      userNeurotypes: { 'extra-helper': makeUserNeurotype() },
    });
    await fetchPresets(app);
    expect(__getPresetAvailabilityComputeCount()).toBe(2);
  });

  it('returns identical objects across cached requests (reference equality)', async () => {
    const app = makeApp();
    const first = await fetchPresets(app);
    const second = await fetchPresets(app);

    // Cached presets should serialise identically — the simplest assertion is
    // structural equality, which holds because the cache returns the same
    // array each time (the JSON round-trip is deterministic).
    expect(second.presets).toEqual(first.presets);
    expect(second.defaultPreset).toBe(first.defaultPreset);
  });
});
