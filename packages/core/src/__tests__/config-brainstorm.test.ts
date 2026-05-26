/**
 * Section 11.4 — TOML loader tests for the optional [brainstorm] block.
 *
 * Covers: defaults applied; overrides applied; invalid values rejected.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, resetConfigCache } from '../config.js';

// Minimal valid neurotypes block required by the loader.
const BASE_TOML = `
[neurotypes.proposer]
model = "llama3.2"
system_prompt = "You are a proposer."
`;

function writeTempToml(dir: string, content: string): string {
  const path = join(dir, 'parliament.toml');
  writeFileSync(path, content, 'utf-8');
  return path;
}

describe('loadConfig [brainstorm] — defaults', () => {
  let tmpDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'parliament-brainstorm-test-'));
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

  it('returns an empty BrainstormConfig when no [brainstorm] block is present', () => {
    const path = writeTempToml(tmpDir, BASE_TOML);
    const config = loadConfig(path);
    expect(config.brainstorm).toEqual({});
  });

  it('returns an empty BrainstormConfig when [brainstorm] block is empty', () => {
    const path = writeTempToml(tmpDir, `${BASE_TOML}\n[brainstorm]\n`);
    const config = loadConfig(path);
    expect(config.brainstorm).toEqual({});
  });
});

describe('loadConfig [brainstorm] — overrides applied', () => {
  let tmpDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'parliament-brainstorm-test-'));
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

  it('parses ideas_per_author', () => {
    const path = writeTempToml(tmpDir, `${BASE_TOML}\n[brainstorm]\nideas_per_author = 10\n`);
    const config = loadConfig(path);
    expect(config.brainstorm.ideas_per_author).toBe(10);
  });

  it('parses ideas_per_author boundary values (1 and 20)', () => {
    for (const v of [1, 20]) {
      resetConfigCache();
      const path = writeTempToml(tmpDir, `${BASE_TOML}\n[brainstorm]\nideas_per_author = ${v}\n`);
      expect(loadConfig(path).brainstorm.ideas_per_author).toBe(v);
    }
  });

  it('parses forge.k', () => {
    const path = writeTempToml(
      tmpDir,
      `${BASE_TOML}\n[brainstorm]\n\n[brainstorm.forge]\nk = 5\n`,
    );
    const config = loadConfig(path);
    expect(config.brainstorm.forge?.k).toBe(5);
  });

  it('parses forge.k boundary values (1 and 10)', () => {
    for (const v of [1, 10]) {
      resetConfigCache();
      const path = writeTempToml(
        tmpDir,
        `${BASE_TOML}\n[brainstorm]\n\n[brainstorm.forge]\nk = ${v}\n`,
      );
      expect(loadConfig(path).brainstorm.forge?.k).toBe(v);
    }
  });

  it('parses partial rank.weights override', () => {
    const path = writeTempToml(
      tmpDir,
      `${BASE_TOML}\n[brainstorm.rank.weights]\nnovelty = 0.5\nfeasibility = 0.2\n`,
    );
    const config = loadConfig(path);
    expect(config.brainstorm.rank?.weights?.novelty).toBe(0.5);
    expect(config.brainstorm.rank?.weights?.feasibility).toBe(0.2);
    // Unspecified criteria are not present in the parsed config (partial-replace)
    expect(config.brainstorm.rank?.weights?.fit).toBeUndefined();
    expect(config.brainstorm.rank?.weights?.evidence).toBeUndefined();
  });

  it('parses full rank.weights override', () => {
    const path = writeTempToml(
      tmpDir,
      `${BASE_TOML}\n[brainstorm.rank.weights]\nnovelty = 0.4\nfeasibility = 0.3\nfit = 0.2\nevidence = 0.1\n`,
    );
    const config = loadConfig(path);
    const weights = config.brainstorm.rank?.weights;
    expect(weights?.novelty).toBe(0.4);
    expect(weights?.feasibility).toBe(0.3);
    expect(weights?.fit).toBe(0.2);
    expect(weights?.evidence).toBe(0.1);
  });

  it('parses lineup.divergentAuthors array', () => {
    const path = writeTempToml(
      tmpDir,
      `${BASE_TOML}\n[brainstorm.lineup]\ndivergentAuthors = ["anthropic/claude-opus-4-6", "openai/gpt-5"]\n`,
    );
    const config = loadConfig(path);
    expect(config.brainstorm.lineup?.divergentAuthors).toEqual([
      'anthropic/claude-opus-4-6',
      'openai/gpt-5',
    ]);
  });

  it('parses lineup.judges array', () => {
    const path = writeTempToml(
      tmpDir,
      `${BASE_TOML}\n[brainstorm.lineup]\njudges = ["anthropic/claude-sonnet-4-6"]\n`,
    );
    const config = loadConfig(path);
    expect(config.brainstorm.lineup?.judges).toEqual(['anthropic/claude-sonnet-4-6']);
  });

  it('parses lineup.cluster and lineup.forgeElaborator strings', () => {
    const path = writeTempToml(
      tmpDir,
      `${BASE_TOML}\n[brainstorm.lineup]\ncluster = "google/gemini-2.5-pro"\nforgeElaborator = "openai/gpt-5"\n`,
    );
    const config = loadConfig(path);
    expect(config.brainstorm.lineup?.cluster).toBe('google/gemini-2.5-pro');
    expect(config.brainstorm.lineup?.forgeElaborator).toBe('openai/gpt-5');
  });

  it('parses all brainstorm keys together', () => {
    const toml = `${BASE_TOML}
[brainstorm]
ideas_per_author = 7

[brainstorm.lineup]
cluster = "google/gemini-2.5-pro"

[brainstorm.rank.weights]
novelty = 0.4
feasibility = 0.3
fit = 0.2
evidence = 0.1

[brainstorm.forge]
k = 4
`;
    const config = loadConfig(writeTempToml(tmpDir, toml));
    expect(config.brainstorm.ideas_per_author).toBe(7);
    expect(config.brainstorm.lineup?.cluster).toBe('google/gemini-2.5-pro');
    expect(config.brainstorm.rank?.weights?.novelty).toBe(0.4);
    expect(config.brainstorm.forge?.k).toBe(4);
  });
});

describe('loadConfig [brainstorm] — invalid values rejected', () => {
  let tmpDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'parliament-brainstorm-test-'));
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

  it('rejects [brainstorm] declared as an array of tables', () => {
    const path = writeTempToml(tmpDir, `${BASE_TOML}\n[[brainstorm]]\n`);
    expect(() => loadConfig(path)).toThrow(/must be a TOML table/);
  });

  it('rejects ideas_per_author = 0 (below minimum)', () => {
    const path = writeTempToml(
      tmpDir,
      `${BASE_TOML}\n[brainstorm]\nideas_per_author = 0\n`,
    );
    expect(() => loadConfig(path)).toThrow(/ideas_per_author/);
    expect(() => loadConfig(path)).toThrow(/\[1, 20\]/);
  });

  it('rejects ideas_per_author = 21 (above maximum)', () => {
    const path = writeTempToml(
      tmpDir,
      `${BASE_TOML}\n[brainstorm]\nideas_per_author = 21\n`,
    );
    expect(() => loadConfig(path)).toThrow(/ideas_per_author/);
  });

  it('rejects non-integer ideas_per_author', () => {
    const path = writeTempToml(
      tmpDir,
      `${BASE_TOML}\n[brainstorm]\nideas_per_author = 3.5\n`,
    );
    expect(() => loadConfig(path)).toThrow(/ideas_per_author/);
  });

  it('rejects forge.k = 0 (below minimum)', () => {
    const path = writeTempToml(
      tmpDir,
      `${BASE_TOML}\n[brainstorm]\n\n[brainstorm.forge]\nk = 0\n`,
    );
    expect(() => loadConfig(path)).toThrow(/forge\.k/);
    expect(() => loadConfig(path)).toThrow(/\[1, 10\]/);
  });

  it('rejects forge.k = 11 (above maximum)', () => {
    const path = writeTempToml(
      tmpDir,
      `${BASE_TOML}\n[brainstorm]\n\n[brainstorm.forge]\nk = 11\n`,
    );
    expect(() => loadConfig(path)).toThrow(/forge\.k/);
  });

  it('rejects negative rank weight', () => {
    const path = writeTempToml(
      tmpDir,
      `${BASE_TOML}\n[brainstorm.rank.weights]\nnovelty = -0.1\n`,
    );
    expect(() => loadConfig(path)).toThrow(/novelty/);
    expect(() => loadConfig(path)).toThrow(/non-negative/);
  });

  it('rejects NaN rank weight (string that is not a number)', () => {
    // TOML won't parse "nan" as a number directly, so test with a non-number type.
    // We test the code path by asserting a string is rejected.
    const path = writeTempToml(
      tmpDir,
      `${BASE_TOML}\n[brainstorm.rank.weights]\nnovelty = "high"\n`,
    );
    expect(() => loadConfig(path)).toThrow(/novelty/);
  });

  it('rejects lineup.divergentAuthors that is not an array', () => {
    const path = writeTempToml(
      tmpDir,
      `${BASE_TOML}\n[brainstorm.lineup]\ndivergentAuthors = "not-an-array"\n`,
    );
    expect(() => loadConfig(path)).toThrow(/divergentAuthors/);
    expect(() => loadConfig(path)).toThrow(/array/);
  });

  it('rejects lineup.cluster that is not a string', () => {
    const path = writeTempToml(
      tmpDir,
      `${BASE_TOML}\n[brainstorm.lineup]\ncluster = 42\n`,
    );
    expect(() => loadConfig(path)).toThrow(/cluster/);
    expect(() => loadConfig(path)).toThrow(/string/);
  });

  it('rejects [brainstorm.lineup] that is not a table', () => {
    const path = writeTempToml(
      tmpDir,
      `${BASE_TOML}\n[brainstorm]\nlineup = "bad"\n`,
    );
    expect(() => loadConfig(path)).toThrow(/\[brainstorm.lineup\]/);
    expect(() => loadConfig(path)).toThrow(/TOML table/);
  });

  it('rejects [brainstorm.rank] that is not a table', () => {
    const path = writeTempToml(tmpDir, `${BASE_TOML}\n[brainstorm]\nrank = "bad"\n`);
    expect(() => loadConfig(path)).toThrow(/\[brainstorm.rank\]/);
    expect(() => loadConfig(path)).toThrow(/TOML table/);
  });

  it('rejects [brainstorm.forge] that is not a table', () => {
    const path = writeTempToml(tmpDir, `${BASE_TOML}\n[brainstorm]\nforge = "bad"\n`);
    expect(() => loadConfig(path)).toThrow(/\[brainstorm.forge\]/);
    expect(() => loadConfig(path)).toThrow(/TOML table/);
  });
});
