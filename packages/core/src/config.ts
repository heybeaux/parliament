import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse } from 'smol-toml';
import type { AgentDefinition } from './debate.js';
import type { ModelAdapter } from './adapters/base.js';
import { loadTopology, type LoadTopologyOptions } from './topology/loader.js';
import type { TopologyConfig } from './topology/types.js';

export interface NeurotypeConfig {
  model: string;
  system_prompt: string;
  /** Provider override for this neurotype: 'ollama' | 'lm_studio' | 'omlx'. Inherits global default if omitted. */
  provider?: string;
}

/** Engine-wide defaults loaded from the optional `[parliament]` table. */
export interface ParliamentDefaults {
  /** Maximum deliberation rounds before forced termination. */
  max_rounds: number;
  /** Synthesizer confidence threshold (0–1) for declaring consensus. */
  confidence_threshold: number;
  /** Inject the RedAgent every N rounds. */
  red_agent_interval: number;
  /** Enable the OSI echo-loop detector. */
  osi_enabled: boolean;
  /**
   * Jaccard *similarity* threshold for the OSI echo-loop detector.
   * If an agent's recent self-similarity stays at or above this value,
   * they are flagged as echoing themselves. Default 0.85 (≡ 0.15 distance,
   * matching the canonical OSI_CONVERGENCE_THRESHOLD calibrated in osi.ts).
   */
  osi_threshold: number;
  /** Port the REST server binds to. */
  server_port: number;
}

export const DEFAULT_PARLIAMENT_DEFAULTS: ParliamentDefaults = {
  max_rounds: 3,
  confidence_threshold: 0.7,
  red_agent_interval: 3,
  osi_enabled: true,
  osi_threshold: 0.85,
  server_port: 3000,
};

export interface ParliamentTomlConfig {
  neurotypes: Record<string, NeurotypeConfig>;
  parliament: ParliamentDefaults;
}

const DEFAULT_CONFIG_FILENAME = 'parliament.toml';

/**
 * Walks upward from `start` looking for the repository root. A directory is
 * considered the root when it contains any of:
 *   - a `.git/` entry,
 *   - a `pnpm-workspace.yaml` file,
 *   - a `package.json` whose top level declares a `workspaces` field.
 * If no such ancestor is found, returns `start` unchanged so callers preserve
 * the previous "fall back to cwd" behaviour.
 */
export function findRepoRoot(start: string = process.cwd()): string {
  let dir = resolve(start);
  // Stop when dirname() returns the same path (filesystem root reached).
  while (true) {
    if (existsSync(resolve(dir, '.git'))) return dir;
    if (existsSync(resolve(dir, 'pnpm-workspace.yaml'))) return dir;

    const pkgPath = resolve(dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
          workspaces?: unknown;
        };
        if (pkg.workspaces !== undefined) return dir;
      } catch {
        // Malformed package.json — keep walking.
      }
    }

    const parent = dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

/**
 * Loads and parses the Parliament TOML config file.
 *
 * Resolution order:
 * 1. `PARLIAMENT_CONFIG` env var (absolute or relative to cwd)
 * 2. `parliament.toml` in the current working directory
 *
 * @throws {Error} If the file cannot be read or contains invalid TOML.
 */
export function loadConfig(explicitPath?: string): ParliamentTomlConfig {
  const configPath = resolveConfigPath(explicitPath);

  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch (err) {
    throw new Error(
      `Parliament: failed to read config at "${configPath}": ${String(err)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch (err) {
    throw new Error(
      `Parliament: invalid TOML in "${configPath}": ${String(err)}`,
    );
  }

  return validateConfig(parsed, configPath);
}

/**
 * Loads the Parliament TOML config file and resolves it into a `TopologyConfig`.
 *
 * Same resolution order as `loadConfig`. When [topology] is absent, the loader
 * falls back to the Debate preset and emits an info-level log via the optional
 * logger. When the file itself is missing, behaves identically to a config
 * with no [topology] block (the topology system is opt-in for legacy users).
 */
export function loadTopologyConfig(
  options: { explicitPath?: string } & LoadTopologyOptions = {},
): TopologyConfig {
  const { explicitPath, ...loadOptions } = options;
  const configPath = resolveConfigPath(explicitPath);

  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch {
    // Treat missing config as "no [topology] block" — the loader will fall
    // back to debate and emit its info log via the supplied logger.
    return loadTopology({}, loadOptions);
  }

  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch (err) {
    throw new Error(
      `Parliament: invalid TOML in "${configPath}": ${String(err)}`,
    );
  }

  return loadTopology(parsed, loadOptions);
}

/**
 * Returns the resolved absolute path to the config file.
 * Prefers `explicitPath`, then `PARLIAMENT_CONFIG` env var, then the default.
 */
export function resolveConfigPath(explicitPath?: string): string {
  const raw =
    explicitPath ?? process.env['PARLIAMENT_CONFIG'] ?? DEFAULT_CONFIG_FILENAME;
  return resolve(findRepoRoot(), raw);
}

function validateConfig(raw: unknown, configPath: string): ParliamentTomlConfig {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`Parliament: config at "${configPath}" must be a TOML table`);
  }

  const top = raw as Record<string, unknown>;

  if (
    typeof top['neurotypes'] !== 'object' ||
    top['neurotypes'] === null ||
    Array.isArray(top['neurotypes'])
  ) {
    throw new Error(
      `Parliament: config at "${configPath}" must have a [neurotypes] table`,
    );
  }

  const rawNeurotypes = top['neurotypes'] as Record<string, unknown>;
  const neurotypes: Record<string, NeurotypeConfig> = {};

  for (const [role, value] of Object.entries(rawNeurotypes)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(
        `Parliament: neurotype "${role}" must be a table with model and system_prompt`,
      );
    }
    const entry = value as Record<string, unknown>;

    if (typeof entry['model'] !== 'string') {
      throw new Error(
        `Parliament: neurotype "${role}" is missing a string "model" field`,
      );
    }
    if (typeof entry['system_prompt'] !== 'string') {
      throw new Error(
        `Parliament: neurotype "${role}" is missing a string "system_prompt" field`,
      );
    }

    neurotypes[role] = {
      model: entry['model'],
      system_prompt: entry['system_prompt'],
      ...(typeof entry['provider'] === 'string' ? { provider: entry['provider'] } : {}),
    };
  }

  const parliament = mergeParliamentDefaults(top['parliament']);

  return { neurotypes, parliament };
}

function mergeParliamentDefaults(raw: unknown): ParliamentDefaults {
  if (raw === undefined || raw === null) return { ...DEFAULT_PARLIAMENT_DEFAULTS };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...DEFAULT_PARLIAMENT_DEFAULTS };
  }

  const entry = raw as Record<string, unknown>;
  const merged: ParliamentDefaults = { ...DEFAULT_PARLIAMENT_DEFAULTS };

  if (typeof entry['max_rounds'] === 'number') merged.max_rounds = entry['max_rounds'];
  if (typeof entry['confidence_threshold'] === 'number') {
    merged.confidence_threshold = entry['confidence_threshold'];
  }
  if (typeof entry['red_agent_interval'] === 'number') {
    merged.red_agent_interval = entry['red_agent_interval'];
  }
  if (typeof entry['osi_enabled'] === 'boolean') merged.osi_enabled = entry['osi_enabled'];
  if (typeof entry['osi_threshold'] === 'number') merged.osi_threshold = entry['osi_threshold'];
  if (typeof entry['server_port'] === 'number') merged.server_port = entry['server_port'];

  return merged;
}

/**
 * Singleton config instance — loaded once on first access.
 * Tests can call `resetConfigCache()` to reload.
 */
let _cached: ParliamentTomlConfig | null = null;

export function getConfig(): ParliamentTomlConfig {
  if (_cached === null) {
    _cached = loadConfig();
  }
  return _cached;
}

/** Returns the NeurotypeConfig for `role`, or throws if the role is not defined. */
export function getNeurotype(role: string): NeurotypeConfig {
  const config = getConfig();
  const neurotype = config.neurotypes[role];
  if (neurotype === undefined) {
    const available = Object.keys(config.neurotypes).join(', ');
    throw new Error(
      `Parliament: unknown neurotype "${role}". Available: ${available}`,
    );
  }
  return neurotype;
}

/** Clears the singleton cache — useful in tests or when the config path changes. */
export function resetConfigCache(): void {
  _cached = null;
}

/**
 * Builds an ordered list of `AgentDefinition` objects from the TOML config.
 *
 * Each neurotype in the config becomes one agent. The `adapterFactory` callback
 * receives the model name and returns the adapter to use for that model.
 * Multiple neurotypes can share the same model — each will have its own
 * adapter instance returned by the factory.
 *
 * @param roles - Ordered list of neurotype role names to include. Defaults to
 *                all roles defined in the config, in definition order.
 * @param adapterFactory - Called once per neurotype with its model name.
 * @returns Ready-to-use AgentDefinition array for `runDebate`.
 *
 * @example
 * const agents = buildAgentsFromConfig(
 *   ['proposer', 'skeptic', 'synthesizer'],
 *   (model) => new OllamaAdapter(model),
 * );
 * await runDebate({ topic, agents });
 */
export function buildAgentsFromConfig(
  roles: string[] | undefined,
  adapterFactory: (model: string, provider?: string) => ModelAdapter,
  config?: ParliamentTomlConfig,
): AgentDefinition[] {
  const cfg = config ?? getConfig();
  const selectedRoles = roles ?? Object.keys(cfg.neurotypes);

  return selectedRoles.map((role) => {
    const neurotype = cfg.neurotypes[role];
    if (neurotype === undefined) {
      const available = Object.keys(cfg.neurotypes).join(', ');
      throw new Error(
        `Parliament: unknown neurotype "${role}". Available: ${available}`,
      );
    }
    return {
      name: role,
      neurotype: role,
      model: neurotype.model,
      adapter: adapterFactory(neurotype.model, neurotype.provider),
      systemPrompt: neurotype.system_prompt,
    };
  });
}
