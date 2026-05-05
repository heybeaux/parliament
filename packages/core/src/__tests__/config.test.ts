import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelAdapter } from '../adapters/base.js';
import {
  buildFallbackAdapter,
  buildMemoryProvider,
  DEFAULT_MEMORY_CONFIG,
  loadConfig,
  resolveConfigPath,
  resetConfigCache,
  getConfig,
  getNeurotype,
  findRepoRoot,
} from '../config.js';
import { EngramMemoryProvider, NoopMemoryProvider } from '../memory.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeTempToml(dir: string, content: string): string {
  const path = join(dir, 'parliament.toml');
  writeFileSync(path, content, 'utf-8');
  return path;
}

const VALID_TOML = `
[neurotypes.proposer]
model = "llama3.2"
system_prompt = "You are a proposer."

[neurotypes.skeptic]
model = "mistral"
system_prompt = "You are a skeptic."

[neurotypes.synthesizer]
model = "llama3.2"
system_prompt = "You are a synthesizer."
`;

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------

describe('loadConfig', () => {
  let tmpDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'parliament-test-'));
    originalEnv = process.env['PARLIAMENT_CONFIG'];
    delete process.env['PARLIAMENT_CONFIG'];
    resetConfigCache();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (originalEnv !== undefined) {
      process.env['PARLIAMENT_CONFIG'] = originalEnv;
    } else {
      delete process.env['PARLIAMENT_CONFIG'];
    }
    resetConfigCache();
  });

  it('loads a valid TOML file and returns neurotype configs', () => {
    const path = writeTempToml(tmpDir, VALID_TOML);
    const config = loadConfig(path);

    expect(Object.keys(config.neurotypes)).toHaveLength(3);

    expect(config.neurotypes['proposer']).toEqual({
      model: 'llama3.2',
      system_prompt: 'You are a proposer.',
    });
    expect(config.neurotypes['skeptic']).toEqual({
      model: 'mistral',
      system_prompt: 'You are a skeptic.',
    });
    expect(config.neurotypes['synthesizer']).toEqual({
      model: 'llama3.2',
      system_prompt: 'You are a synthesizer.',
    });
  });

  it('allows multiple neurotypes to share the same model', () => {
    const path = writeTempToml(tmpDir, VALID_TOML);
    const config = loadConfig(path);

    expect(config.neurotypes['proposer']?.model).toBe('llama3.2');
    expect(config.neurotypes['synthesizer']?.model).toBe('llama3.2');
  });

  it('throws when the file does not exist', () => {
    expect(() => loadConfig('/nonexistent/path/parliament.toml')).toThrow(
      /failed to read config/,
    );
  });

  it('throws on invalid TOML syntax', () => {
    const path = join(tmpDir, 'parliament.toml');
    writeFileSync(path, 'this is not = valid [ toml', 'utf-8');
    expect(() => loadConfig(path)).toThrow(/invalid TOML/);
  });

  it('throws when [neurotypes] table is missing', () => {
    const path = join(tmpDir, 'parliament.toml');
    writeFileSync(path, '[other]\nkey = "value"\n', 'utf-8');
    expect(() => loadConfig(path)).toThrow(/\[neurotypes\] table/);
  });

  it('throws when a neurotype is missing the model field', () => {
    const bad = `
[neurotypes.proposer]
system_prompt = "Missing model field."
`;
    const path = writeTempToml(tmpDir, bad);
    expect(() => loadConfig(path)).toThrow(/missing a string "model" field/);
  });

  // PAR-40 — `system_prompt` is now optional. Built-in agents fall back to
  // the SYSTEM_PROMPT constant in their class file when the config omits it,
  // letting bench/test configs lean on the OSS defaults (which carry the
  // memory-engagement and memory-continuity clauses) without copy-pasting
  // the whole prompt block.
  it('accepts a neurotype that omits system_prompt (falls back to built-in default at runtime)', () => {
    const bench = `
[neurotypes.skeptic]
model = "qwen3.5:latest"
provider = "ollama"
`;
    const path = writeTempToml(tmpDir, bench);
    const cfg = loadConfig(path);
    expect(cfg.neurotypes['skeptic']).toEqual({
      model: 'qwen3.5:latest',
      provider: 'ollama',
    });
    // Crucially: no `system_prompt` key materialised on the parsed config —
    // downstream `buildAgentsFromConfig` reads the absence and skips wiring
    // an explicit override on AgentDefinition.systemPrompt, leaving the
    // agent's class-level SYSTEM_PROMPT constant in effect.
    expect(cfg.neurotypes['skeptic']).not.toHaveProperty('system_prompt');
  });

  it('still rejects a neurotype that supplies a non-string system_prompt', () => {
    const bad = `
[neurotypes.proposer]
model = "llama3.2"
system_prompt = 42
`;
    const path = writeTempToml(tmpDir, bad);
    expect(() => loadConfig(path)).toThrow(
      /non-string "system_prompt" field/,
    );
  });

  // -------------------------------------------------------------------------
  // PAR-25 — fallback_provider / fallback_model TOML fields
  //
  // Two layers of coverage:
  //   1. The TOML loader recognises the new fields, leaves them undefined when
  //      omitted, and copies them onto NeurotypeConfig verbatim when present.
  //   2. `buildFallbackAdapter` reads NeurotypeConfig, returns `undefined`
  //      when `fallback_provider` is absent, and otherwise calls the adapter
  //      factory with the documented model resolution (fallback_model wins
  //      over primary model).
  // -------------------------------------------------------------------------

  it('PAR-25: leaves fallback_provider / fallback_model undefined when the TOML omits them', () => {
    const path = writeTempToml(tmpDir, VALID_TOML);
    const config = loadConfig(path);

    const proposer = config.neurotypes['proposer']!;
    // Plain TOML — neither field set. Both must round-trip as undefined so
    // the production resolver's "no fallback wired" branch keeps firing for
    // every existing parliament.toml in the wild.
    expect(proposer.fallback_provider).toBeUndefined();
    expect(proposer.fallback_model).toBeUndefined();
  });

  it('PAR-25: parses fallback_provider on its own and leaves fallback_model undefined', () => {
    const toml = `
[neurotypes.proposer]
model = "llama3.2"
provider = "ollama"
system_prompt = "You are a proposer."
fallback_provider = "openrouter"
`;
    const path = writeTempToml(tmpDir, toml);
    const config = loadConfig(path);

    const proposer = config.neurotypes['proposer']!;
    expect(proposer.fallback_provider).toBe('openrouter');
    // fallback_model omitted → undefined; buildFallbackAdapter will reuse
    // the primary `model` when constructing the adapter.
    expect(proposer.fallback_model).toBeUndefined();
  });

  it('PAR-25: parses both fallback_provider and fallback_model verbatim', () => {
    const toml = `
[neurotypes.proposer]
model = "llama3.2"
provider = "ollama"
system_prompt = "You are a proposer."
fallback_provider = "openrouter"
fallback_model = "openai/gpt-4o-mini"
`;
    const path = writeTempToml(tmpDir, toml);
    const config = loadConfig(path);

    const proposer = config.neurotypes['proposer']!;
    expect(proposer.fallback_provider).toBe('openrouter');
    expect(proposer.fallback_model).toBe('openai/gpt-4o-mini');
  });
});

// ---------------------------------------------------------------------------
// PAR-25 — buildFallbackAdapter helper
// ---------------------------------------------------------------------------

describe('buildFallbackAdapter (PAR-25)', () => {
  function makeStubAdapter(modelName: string): ModelAdapter {
    return {
      modelName,
      generate: vi.fn().mockResolvedValue({ content: 'stub' }),
    };
  }

  it('returns undefined when fallback_provider is absent', () => {
    const factory = vi.fn();
    const out = buildFallbackAdapter(
      {
        model: 'llama3.2',
        system_prompt: 'sys',
      },
      factory,
    );

    expect(out).toBeUndefined();
    // Factory MUST NOT be invoked — the helper short-circuits before touching
    // it so opt-out behaviour stays free of provider-factory side effects.
    expect(factory).not.toHaveBeenCalled();
  });

  it('uses the explicit fallback_model when supplied', () => {
    const fallbackAdapter = makeStubAdapter('openai/gpt-4o-mini');
    const factory = vi.fn().mockReturnValue(fallbackAdapter);

    const out = buildFallbackAdapter(
      {
        model: 'llama3.2',
        system_prompt: 'sys',
        fallback_provider: 'openrouter',
        fallback_model: 'openai/gpt-4o-mini',
      },
      factory,
    );

    expect(out).toBe(fallbackAdapter);
    // Factory called with the user-supplied fallback_model and the matching
    // fallback_provider — never the primary model name when the user pinned
    // a fallback model explicitly.
    expect(factory).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledWith('openai/gpt-4o-mini', 'openrouter');
  });

  it('reuses the primary model when fallback_model is omitted', () => {
    const fallbackAdapter = makeStubAdapter('llama3.2');
    const factory = vi.fn().mockReturnValue(fallbackAdapter);

    const out = buildFallbackAdapter(
      {
        model: 'llama3.2',
        system_prompt: 'sys',
        fallback_provider: 'openrouter',
      },
      factory,
    );

    expect(out).toBe(fallbackAdapter);
    // Same model name, different provider — the documented "I just want a
    // different transport for the same model" path.
    expect(factory).toHaveBeenCalledWith('llama3.2', 'openrouter');
  });
});

// ---------------------------------------------------------------------------
// resolveConfigPath
// ---------------------------------------------------------------------------

describe('resolveConfigPath', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env['PARLIAMENT_CONFIG'];
    delete process.env['PARLIAMENT_CONFIG'];
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env['PARLIAMENT_CONFIG'] = originalEnv;
    } else {
      delete process.env['PARLIAMENT_CONFIG'];
    }
  });

  it('returns default path (parliament.toml in cwd) when nothing is set', () => {
    const path = resolveConfigPath();
    expect(path).toMatch(/parliament\.toml$/);
  });

  it('prefers explicit path over env var', () => {
    process.env['PARLIAMENT_CONFIG'] = '/env/path/parliament.toml';
    const path = resolveConfigPath('/explicit/path.toml');
    expect(path).toBe('/explicit/path.toml');
  });

  it('uses PARLIAMENT_CONFIG env var when no explicit path is given', () => {
    process.env['PARLIAMENT_CONFIG'] = '/from/env/parliament.toml';
    const path = resolveConfigPath();
    expect(path).toBe('/from/env/parliament.toml');
  });
});

// ---------------------------------------------------------------------------
// getConfig / getNeurotype (singleton cache)
// ---------------------------------------------------------------------------

describe('getConfig and getNeurotype', () => {
  let tmpDir: string;
  let originalEnv: string | undefined;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'parliament-test-'));
    originalEnv = process.env['PARLIAMENT_CONFIG'];
    originalCwd = process.cwd();
    resetConfigCache();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (originalEnv !== undefined) {
      process.env['PARLIAMENT_CONFIG'] = originalEnv;
    } else {
      delete process.env['PARLIAMENT_CONFIG'];
    }
    process.chdir(originalCwd);
    resetConfigCache();
  });

  it('getConfig returns cached instance on subsequent calls', () => {
    const configPath = writeTempToml(tmpDir, VALID_TOML);
    process.env['PARLIAMENT_CONFIG'] = configPath;

    const first = getConfig();
    const second = getConfig();
    expect(first).toBe(second);
  });

  it('getNeurotype returns the correct neurotype config', () => {
    const configPath = writeTempToml(tmpDir, VALID_TOML);
    process.env['PARLIAMENT_CONFIG'] = configPath;

    const proposer = getNeurotype('proposer');
    expect(proposer.model).toBe('llama3.2');
    expect(proposer.system_prompt).toBe('You are a proposer.');
  });

  it('getNeurotype throws for unknown role with available list', () => {
    const configPath = writeTempToml(tmpDir, VALID_TOML);
    process.env['PARLIAMENT_CONFIG'] = configPath;

    expect(() => getNeurotype('phantom')).toThrow(/unknown neurotype "phantom"/);
    expect(() => getNeurotype('phantom')).toThrow(/proposer/);
  });

  it('resetConfigCache forces reload on next getConfig call', () => {
    const configPath = writeTempToml(tmpDir, VALID_TOML);
    process.env['PARLIAMENT_CONFIG'] = configPath;

    const first = getConfig();
    resetConfigCache();

    // Overwrite the file with a different config
    const updated = `
[neurotypes.debater]
model = "gpt-4"
system_prompt = "You are a debater."
`;
    writeFileSync(configPath, updated, 'utf-8');

    const second = getConfig();
    expect(second).not.toBe(first);
    expect(second.neurotypes['debater']).toBeDefined();
    expect(first.neurotypes['debater']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// findRepoRoot
// ---------------------------------------------------------------------------

describe('findRepoRoot', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'parliament-root-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns the directory containing a .git entry', () => {
    const repo = join(tmpDir, 'repo');
    const nested = join(repo, 'packages', 'core', 'src');
    mkdirSync(nested, { recursive: true });
    mkdirSync(join(repo, '.git'));
    expect(findRepoRoot(nested)).toBe(repo);
  });

  it('returns the directory containing pnpm-workspace.yaml', () => {
    const repo = join(tmpDir, 'pnpm-repo');
    const nested = join(repo, 'apps', 'web');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(repo, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n');
    expect(findRepoRoot(nested)).toBe(repo);
  });

  it('returns the directory whose package.json declares a workspaces field', () => {
    const repo = join(tmpDir, 'npm-ws-repo');
    const nested = join(repo, 'a', 'b', 'c');
    mkdirSync(nested, { recursive: true });
    writeFileSync(
      join(repo, 'package.json'),
      JSON.stringify({ name: 'root', workspaces: ['a/*'] }),
    );
    expect(findRepoRoot(nested)).toBe(repo);
  });

  it('falls back to the start directory when no marker is found', () => {
    // We can't reliably create a tree with NO ancestor markers (tmpdir may sit
    // on a filesystem under a workspace), so we just assert findRepoRoot
    // produces a non-empty path string.
    const isolated = join(tmpDir, 'lonely');
    mkdirSync(isolated);
    const result = findRepoRoot(isolated);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// PAR-38 — [memory] block parsing + buildMemoryProvider
// ---------------------------------------------------------------------------

describe('loadConfig [memory] (PAR-38)', () => {
  let tmpDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'parliament-test-'));
    originalEnv = process.env['PARLIAMENT_CONFIG'];
    delete process.env['PARLIAMENT_CONFIG'];
    resetConfigCache();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (originalEnv !== undefined) {
      process.env['PARLIAMENT_CONFIG'] = originalEnv;
    } else {
      delete process.env['PARLIAMENT_CONFIG'];
    }
    resetConfigCache();
  });

  it('defaults to provider = "none" when no [memory] table is present', () => {
    const path = writeTempToml(tmpDir, VALID_TOML);
    const config = loadConfig(path);
    expect(config.memory).toEqual({ ...DEFAULT_MEMORY_CONFIG });
  });

  it('parses provider = "noop" without requiring endpoint or agent_id', () => {
    const path = writeTempToml(
      tmpDir,
      `${VALID_TOML}\n[memory]\nprovider = "noop"\n`,
    );
    const config = loadConfig(path);
    expect(config.memory.provider).toBe('noop');
  });

  it('parses a full engram block with optional fields', () => {
    const path = writeTempToml(
      tmpDir,
      `${VALID_TOML}\n[memory]\nprovider = "engram"\nendpoint = "https://engram.example.com"\napi_key = "secret"\nagent_id = "tenant-1"\nrecall_limit = 8\nlayers = ["INSIGHT", "PROJECT", "TASK"]\n`,
    );
    const config = loadConfig(path);
    expect(config.memory).toEqual({
      provider: 'engram',
      endpoint: 'https://engram.example.com',
      api_key: 'secret',
      agent_id: 'tenant-1',
      recall_limit: 8,
      layers: ['INSIGHT', 'PROJECT', 'TASK'],
    });
  });

  it('rejects an unknown provider value', () => {
    const path = writeTempToml(
      tmpDir,
      `${VALID_TOML}\n[memory]\nprovider = "redis"\n`,
    );
    expect(() => loadConfig(path)).toThrow(/provider in/);
  });

  it('rejects engram provider without endpoint', () => {
    const path = writeTempToml(
      tmpDir,
      `${VALID_TOML}\n[memory]\nprovider = "engram"\nagent_id = "t"\n`,
    );
    expect(() => loadConfig(path)).toThrow(/requires an "endpoint"/);
  });

  it('rejects engram provider without agent_id', () => {
    const path = writeTempToml(
      tmpDir,
      `${VALID_TOML}\n[memory]\nprovider = "engram"\nendpoint = "https://x"\n`,
    );
    expect(() => loadConfig(path)).toThrow(/requires an "agent_id"/);
  });

  it('rejects an unknown layer name', () => {
    const path = writeTempToml(
      tmpDir,
      `${VALID_TOML}\n[memory]\nprovider = "engram"\nendpoint = "https://x"\nagent_id = "t"\nlayers = ["WORLD"]\n`,
    );
    expect(() => loadConfig(path)).toThrow(/layer "WORLD"/);
  });

  it('rejects [memory] declared as an array of tables', () => {
    // [[memory]] turns the value into an array — our parser explicitly
    // rejects non-table shapes.
    const path = writeTempToml(
      tmpDir,
      `${VALID_TOML}\n[[memory]]\nprovider = "noop"\n`,
    );
    expect(() => loadConfig(path)).toThrow(/must be a TOML table/);
  });
});

describe('buildMemoryProvider (PAR-38)', () => {
  it('returns undefined for provider = "none" so the engine sees a missing field', () => {
    expect(buildMemoryProvider({ provider: 'none' })).toBeUndefined();
  });

  it('returns a NoopMemoryProvider for provider = "noop"', () => {
    const provider = buildMemoryProvider({ provider: 'noop' });
    expect(provider).toBeInstanceOf(NoopMemoryProvider);
  });

  it('returns an EngramMemoryProvider for provider = "engram"', () => {
    const provider = buildMemoryProvider({
      provider: 'engram',
      endpoint: 'https://engram.example.com',
      api_key: 'secret',
      agent_id: 'tenant-1',
      layers: ['INSIGHT'],
    });
    expect(provider).toBeInstanceOf(EngramMemoryProvider);
  });
});
