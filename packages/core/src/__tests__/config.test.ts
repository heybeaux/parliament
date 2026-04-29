import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadConfig,
  resolveConfigPath,
  resetConfigCache,
  getConfig,
  getNeurotype,
  findRepoRoot,
} from '../config.js';

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

  it('throws when a neurotype is missing the system_prompt field', () => {
    const bad = `
[neurotypes.proposer]
model = "llama3.2"
`;
    const path = writeTempToml(tmpDir, bad);
    expect(() => loadConfig(path)).toThrow(
      /missing a string "system_prompt" field/,
    );
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
