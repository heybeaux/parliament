import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Per-agent model overrides (desktop Settings → Models picker).
//
// Covers:
//   - GET /settings now carries the per-role model map (default / effective /
//     override_active).
//   - PUT /settings/models round-trip: set an override, see it reflected in
//     the response, on a subsequent GET, and in the settings file on disk;
//     null / empty string clears back to the TOML default.
//   - Overrides apply at agent-construction time: the next POST /deliberate
//     builds adapters with the overridden model — no restart.
//   - GET /models proxies OpenRouter's catalog (id + name only, sorted) and
//     caches it in memory; upstream failure with a cold cache → 502.
//   - settings.ts read-side validation drops junk override entries.
// ---------------------------------------------------------------------------

vi.mock('@parliament/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@parliament/core')>();

  const mockResult = {
    topic: 'test topic',
    turns: [],
    conflicts: [],
    residueScore: 0,
    resolved: true,
    synthesis: 'Synthesized conclusion.',
    split: null,
    terminationReason: 'consensus',
    totalRounds: 1,
    started_at: '2026-01-01T00:00:00.000Z',
    completed_at: '2026-01-01T00:00:30.000Z',
    events: [],
  };

  const MockDeliberationEngine = vi.fn().mockImplementation(() => ({
    run: vi.fn().mockResolvedValue(mockResult),
    runTopology: vi.fn().mockResolvedValue(mockResult),
  }));

  const baseTopology = {
    activePreset: actual.BUILTIN_PRESETS['debate']!,
    presets: { ...actual.BUILTIN_PRESETS },
    userNeurotypes: {},
  };

  return {
    ...actual,
    DeliberationEngine: MockDeliberationEngine,
    loadTopologyConfig: vi.fn().mockReturnValue(baseTopology),
    loadConfig: vi.fn().mockReturnValue({
      neurotypes: {
        proposer: { model: 'default/proposer' },
        skeptic: { model: 'default/skeptic' },
        synthesizer: { model: 'default/synthesizer' },
        redAgent: { model: 'default/red-agent' },
        sentry: { model: 'default/sentry' },
        historian: { model: 'default/builtin' },
        forecaster: { model: 'default/builtin' },
        pragmatist: { model: 'default/builtin' },
        empiricist: { model: 'default/builtin' },
        steelmanner: { model: 'default/builtin' },
        'devils-advocate': { model: 'default/builtin' },
        lateralist: { model: 'default/builtin' },
        translator: { model: 'default/builtin' },
      },
    }),
    createAdapter: vi.fn().mockReturnValue({
      generate: vi.fn().mockResolvedValue({ content: 'ok' }),
    }),
    SynthesizerAgent: vi.fn().mockImplementation(() => ({
      role: 'Synthesizer',
      neurotype: 'integrative',
      generate: vi.fn(),
    })),
    RedAgent: vi.fn().mockImplementation(() => ({
      role: 'RedAgent',
      neurotype: 'adversarial',
      generate: vi.fn(),
    })),
    SentryAgent: vi.fn().mockImplementation(() => ({
      role: 'Sentry',
      neurotype: 'monitoring',
      generate: vi.fn(),
    })),
  };
});

vi.mock('../db.js', () => ({
  initDb: vi.fn().mockReturnValue({}),
  saveDeliberation: vi.fn(),
  getDeliberation: vi.fn(),
  createDeliberationRow: vi.fn(),
  appendTurn: vi.fn(),
  appendEvent: vi.fn(),
  markCompleted: vi.fn(),
  markFailed: vi.fn(),
  listDeliberations: vi.fn().mockReturnValue([]),
}));

import { createAdapter } from '@parliament/core';
import { createRouter, clearModelsCatalogCache } from '../routes.js';
import { loadSettings, sanitizeModelOverrides } from '../settings.js';

function makeApp() {
  const fakeDb = {} as import('better-sqlite3').Database;
  return createRouter(fakeDb);
}

let settingsDir: string;
let settingsFile: string;

beforeEach(() => {
  settingsDir = mkdtempSync(join(tmpdir(), 'parliament-settings-'));
  settingsFile = join(settingsDir, 'settings.json');
  process.env['PARLIAMENT_SETTINGS_PATH'] = settingsFile;
  clearModelsCatalogCache();
  vi.clearAllMocks();
});

afterEach(() => {
  delete process.env['PARLIAMENT_SETTINGS_PATH'];
  rmSync(settingsDir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe('GET /settings — per-role model status', () => {
  it('reports config defaults with no overrides active', async () => {
    const app = makeApp();
    const res = await app.request('/settings');
    expect(res.status).toBe(200);

    const body = (await res.json()) as { models: Record<string, unknown> };
    expect(body.models).toEqual({
      proposer: { default: 'default/proposer', effective: 'default/proposer', override_active: false },
      skeptic: { default: 'default/skeptic', effective: 'default/skeptic', override_active: false },
      synthesizer: { default: 'default/synthesizer', effective: 'default/synthesizer', override_active: false },
      redAgent: { default: 'default/red-agent', effective: 'default/red-agent', override_active: false },
      sentry: { default: 'default/sentry', effective: 'default/sentry', override_active: false },
    });
  });
});

describe('PUT /settings/models — override round-trip', () => {
  it('sets an override, persists it, and reflects it on GET', async () => {
    const app = makeApp();

    const put = await app.request('/settings/models', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model_overrides: { synthesizer: 'custom/synth-model' } }),
    });
    expect(put.status).toBe(200);

    const putBody = (await put.json()) as {
      ok: boolean;
      models: Record<string, { default: string; effective: string; override_active: boolean }>;
    };
    expect(putBody.ok).toBe(true);
    expect(putBody.models['synthesizer']).toEqual({
      default: 'default/synthesizer',
      effective: 'custom/synth-model',
      override_active: true,
    });
    // Untouched roles stay on their defaults.
    expect(putBody.models['proposer']!.override_active).toBe(false);

    // Round-trips through the persisted file…
    const onDisk = JSON.parse(readFileSync(settingsFile, 'utf-8')) as Record<string, unknown>;
    expect(onDisk['model_overrides']).toEqual({ synthesizer: 'custom/synth-model' });

    // …and through a fresh GET /settings.
    const get = await app.request('/settings');
    const getBody = (await get.json()) as {
      models: Record<string, { effective: string; override_active: boolean }>;
    };
    expect(getBody.models['synthesizer']!.effective).toBe('custom/synth-model');
    expect(getBody.models['synthesizer']!.override_active).toBe(true);
  });

  it('clears an override with null (and with empty string)', async () => {
    const app = makeApp();

    await app.request('/settings/models', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model_overrides: { proposer: 'x/one', skeptic: 'x/two' },
      }),
    });

    const res = await app.request('/settings/models', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model_overrides: { proposer: null, skeptic: '' } }),
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      models: Record<string, { effective: string; override_active: boolean }>;
    };
    expect(body.models['proposer']).toEqual({
      default: 'default/proposer',
      effective: 'default/proposer',
      override_active: false,
    });
    expect(body.models['skeptic']!.override_active).toBe(false);
    expect(loadSettings().model_overrides ?? {}).toEqual({});
  });

  it('rejects a non-string / non-null override value with 400', async () => {
    const app = makeApp();
    const res = await app.request('/settings/models', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model_overrides: { proposer: 42 } }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_body');
  });

  it('applies the override to adapters built for the NEXT deliberation (no restart)', async () => {
    const app = makeApp();

    await app.request('/settings/models', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model_overrides: { synthesizer: 'custom/synth-model', proposer: 'custom/proposer-model' },
      }),
    });

    const res = await app.request('/deliberate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: 'override wiring test' }),
    });
    expect(res.status).toBe(202);
    // Let the fire-and-forget background runner construct its agents.
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Structural agents (synthesizer / redAgent / sentry) are built eagerly
    // when the topology config is assembled.
    const models = vi.mocked(createAdapter).mock.calls.map(([model]) => model);
    expect(models).toContain('custom/synth-model');
    // Un-overridden roles still use the TOML default.
    expect(models).toContain('default/sentry');
    // The stale default for an overridden role is NOT constructed.
    expect(models).not.toContain('default/synthesizer');

    // Step agents (proposer / skeptic) are built lazily by the per-step
    // resolver the engine receives — invoke it the way the engine would.
    const { DeliberationEngine } = await import('@parliament/core');
    const engine = vi.mocked(DeliberationEngine).mock.results.at(-1)!.value as {
      runTopology: ReturnType<typeof vi.fn>;
    };
    const [, topologyConfig] = engine.runTopology.mock.calls[0] as [
      string,
      {
        resolveNeurotype: (step: { id: string; neurotype: string }) => unknown;
      },
    ];
    topologyConfig.resolveNeurotype({ id: 'step-1', neurotype: 'proposer' });
    const modelsAfter = vi.mocked(createAdapter).mock.calls.map(([model]) => model);
    expect(modelsAfter).toContain('custom/proposer-model');
    expect(modelsAfter).not.toContain('default/proposer');
  });
});

describe('settings.ts — override validation on read', () => {
  it('drops unknown roles and non-string values from a hand-edited file', () => {
    writeFileSync(
      settingsFile,
      JSON.stringify({
        openrouter_api_key: 'sk-or-v1-test',
        model_overrides: {
          synthesizer: 'good/model',
          proposer: 17,
          skeptic: '   ',
          notARole: 'x/y',
          sentry: null,
        },
      }),
    );
    const settings = loadSettings();
    expect(settings.model_overrides).toEqual({ synthesizer: 'good/model' });
  });

  it('sanitizeModelOverrides tolerates non-object junk', () => {
    expect(sanitizeModelOverrides('nope')).toEqual({});
    expect(sanitizeModelOverrides(['a'])).toEqual({});
    expect(sanitizeModelOverrides(null)).toEqual({});
  });
});

describe('GET /models — OpenRouter catalog proxy', () => {
  const catalogPayload = {
    data: [
      { id: 'z/zeta', name: 'Zeta', pricing: { prompt: '0' } },
      { id: 'a/alpha', name: 'Alpha', context_length: 4096 },
      { id: 'm/mid' }, // no name → falls back to id
      { name: 'no id — dropped' },
    ],
  };

  it('returns id + name only, sorted by name, and caches in memory', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(catalogPayload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const app = makeApp();
    const res = await app.request('/models');
    expect(res.status).toBe(200);

    const body = (await res.json()) as { models: Array<{ id: string; name: string }>; cached: boolean };
    expect(body.cached).toBe(false);
    expect(body.models).toEqual([
      { id: 'a/alpha', name: 'Alpha' },
      { id: 'm/mid', name: 'm/mid' },
      { id: 'z/zeta', name: 'Zeta' },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toBe('https://openrouter.ai/api/v1/models');

    // Second request is served from the in-memory cache — no refetch.
    const second = await app.request('/models');
    const secondBody = (await second.json()) as { cached: boolean };
    expect(secondBody.cached).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns 502 when upstream fails and the cache is cold', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    const app = makeApp();
    const res = await app.request('/models');
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('models_fetch_failed');
  });

  it('serves the stale cache when upstream starts failing', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(catalogPayload), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockRejectedValue(new Error('down'));
    vi.stubGlobal('fetch', fetchMock);

    const app = makeApp();
    await app.request('/models');

    // Force expiry so the route attempts (and fails) a refresh.
    const realNow = Date.now;
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 2 * 60 * 60 * 1000);
    try {
      const res = await app.request('/models');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { models: unknown[]; cached: boolean };
      expect(body.cached).toBe(true);
      expect(body.models).toHaveLength(3);
    } finally {
      vi.mocked(Date.now).mockRestore();
    }
  });
});
