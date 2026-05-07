import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse } from 'smol-toml';
import type { AgentDefinition } from './debate.js';
import type { ModelAdapter } from './adapters/base.js';
import { loadTopology, type LoadTopologyOptions } from './topology/loader.js';
import type { TopologyConfig } from './topology/types.js';
import {
  EngramMemoryProvider,
  NoopMemoryProvider,
  type MemoryLayer,
  type MemoryProvider,
} from './memory.js';
import { ACRContextProvider, type ContextProvider } from './context.js';
import type { IdeateConfig, IdeateMode, LineupRole } from './ideate/types.js';

export interface NeurotypeConfig {
  model: string;
  /**
   * Optional system prompt override. Built-in neurotypes (Proposer, Skeptic,
   * Synthesizer, RedAgent, etc.) ship with a default prompt baked into the
   * agent class — when this field is omitted, the built-in default is used
   * at runtime. User-defined neurotypes in topology presets MUST supply a
   * system_prompt (the topology loader enforces that separately) because no
   * default exists for them.
   *
   * PAR-40 — making this optional lets configs lean on the OSS default
   * Skeptic / Synthesizer prompts (which now carry memory-engagement and
   * memory-continuity clauses) without copy-pasting the whole prompt block.
   */
  system_prompt?: string;
  /** Provider override for this neurotype: 'ollama' | 'lm_studio' | 'omlx'. Inherits global default if omitted. */
  provider?: string;
  /**
   * PAR-25 — optional provider to retry once on `ModelConnectionError`.
   * When set, `fallback_model` may also be set (defaults to `model` if
   * omitted). The engine emits a `provider.failover` SystemEvent on retry
   * and `Turn.meta.provider` reflects whichever provider produced the
   * content.
   *
   * Default behaviour is unchanged when this field is absent: a primary
   * `ModelConnectionError` propagates as today and the deliberation fails.
   */
  fallback_provider?: string;
  /**
   * PAR-25 — model name to use with `fallback_provider`. Optional; when
   * omitted the primary `model` name is reused. Useful when the fallback
   * provider doesn't host the same model id (e.g. omlx local model name vs
   * OpenRouter's `google/gemini-flash-1.5`).
   */
  fallback_model?: string;
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

/**
 * PAR-38 — Memory provider configuration parsed from the optional `[memory]`
 * table.
 *
 * Default (no table, or `provider = "none"`) leaves memory wiring inactive —
 * the engine sees `memoryProvider: undefined` and skips all recall/remember
 * calls. `provider = "engram"` turns on the Engram adapter; the rest of the
 * fields configure it.
 *
 * Endpoint and agent_id MUST be set when `provider = "engram"`. Validation
 * surfaces a clear error rather than silently degrading to noop.
 */
export type MemoryProviderKind = 'none' | 'noop' | 'engram';

export interface MemoryConfig {
  provider: MemoryProviderKind;
  /** Engram base URL — required when provider === 'engram'. */
  endpoint?: string;
  /** Optional bearer token forwarded as `authorization: Bearer <token>`. */
  api_key?: string;
  /**
   * Per-account scoping passed to the provider as `x-am-agent-id`. Required
   * when provider === 'engram'. The CLI / server may also override this from
   * a request-time tenant id.
   */
  agent_id?: string;
  /** Max recall fragments per deliberation. Default 5. */
  recall_limit?: number;
  /** Layers to filter recall against. Default ['INSIGHT', 'PROJECT']. */
  layers?: MemoryLayer[];
}

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = { provider: 'none' };

/**
 * PAR-39 — Context provider configuration parsed from the optional `[context]`
 * table.
 *
 * Default (no table, or `provider = "none"`) is a noop — the engine sees no
 * `contextProvider` and skips ACR resolution entirely. `provider = "acr"`
 * enables the ACRContextProvider; `manifest_path` is required.
 */
export type ContextProviderKind = 'none' | 'acr';

export interface ContextConfig {
  provider: ContextProviderKind;
  /** Absolute path to the `.acr` manifest directory. Required when provider === 'acr'. */
  manifest_path?: string;
  /** Scale factor applied to the ACR budget token count. Default 1.0. */
  budget_multiplier?: number;
  /** Cache TTL in ms for resolved contexts. Default 60000. */
  cache_ttl_ms?: number;
}

export const DEFAULT_CONTEXT_CONFIG: ContextConfig = { provider: 'none' };

export interface ParliamentTomlConfig {
  neurotypes: Record<string, NeurotypeConfig>;
  parliament: ParliamentDefaults;
  memory: MemoryConfig;
  context: ContextConfig;
  /**
   * Optional `[ideate]` block — strict-by-default lineup + synthesizer
   * overrides for the ideate mode. Missing → in-code defaults from
   * `@parliament/core/src/ideate/lineup.ts` apply unchanged.
   */
  ideate: IdeateConfig;
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
    // PAR-40 — `system_prompt` is now optional. When omitted, built-in
    // agents fall back to the SYSTEM_PROMPT constant in their class file.
    // Validate the type only when the field is present — a non-string here
    // is still a misconfiguration we want to surface loudly.
    if (
      entry['system_prompt'] !== undefined &&
      typeof entry['system_prompt'] !== 'string'
    ) {
      throw new Error(
        `Parliament: neurotype "${role}" has a non-string "system_prompt" field`,
      );
    }

    neurotypes[role] = {
      model: entry['model'],
      ...(typeof entry['system_prompt'] === 'string'
        ? { system_prompt: entry['system_prompt'] }
        : {}),
      ...(typeof entry['provider'] === 'string' ? { provider: entry['provider'] } : {}),
      // PAR-25 — opt-in failover. `fallback_provider` is the trigger; when
      // absent every other failover branch is skipped. `fallback_model` is
      // independently optional (defaults to the primary `model` at adapter
      // construction time, not here, so the consumer sees the user-supplied
      // value verbatim).
      ...(typeof entry['fallback_provider'] === 'string'
        ? { fallback_provider: entry['fallback_provider'] }
        : {}),
      ...(typeof entry['fallback_model'] === 'string'
        ? { fallback_model: entry['fallback_model'] }
        : {}),
    };
  }

  const parliament = mergeParliamentDefaults(top['parliament']);
  const memory = parseMemoryConfig(top['memory'], configPath);
  const context = parseContextConfig(top['context'], configPath);
  const ideate = parseIdeateConfig(top['ideate'], configPath);

  return { neurotypes, parliament, memory, context, ideate };
}

/**
 * PAR-38 — parses the optional `[memory]` table. Missing table → noop default.
 * `provider = "engram"` requires `endpoint` and `agent_id`.
 */
function parseMemoryConfig(raw: unknown, configPath: string): MemoryConfig {
  if (raw === undefined || raw === null) {
    return { ...DEFAULT_MEMORY_CONFIG };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(
      `Parliament: [memory] in "${configPath}" must be a TOML table`,
    );
  }

  const entry = raw as Record<string, unknown>;
  const providerRaw = entry['provider'];
  let provider: MemoryProviderKind = 'none';
  if (typeof providerRaw === 'string') {
    if (providerRaw === 'none' || providerRaw === 'noop' || providerRaw === 'engram') {
      provider = providerRaw;
    } else {
      throw new Error(
        `Parliament: [memory] provider in "${configPath}" must be one of "none", "noop", or "engram" (got "${providerRaw}")`,
      );
    }
  }

  const out: MemoryConfig = { provider };

  if (typeof entry['endpoint'] === 'string') out.endpoint = entry['endpoint'];
  if (typeof entry['api_key'] === 'string') out.api_key = entry['api_key'];
  if (typeof entry['agent_id'] === 'string') out.agent_id = entry['agent_id'];
  if (typeof entry['recall_limit'] === 'number') {
    out.recall_limit = entry['recall_limit'];
  }
  if (Array.isArray(entry['layers'])) {
    const validLayers: readonly MemoryLayer[] = [
      'IDENTITY',
      'PROJECT',
      'SESSION',
      'TASK',
      'INSIGHT',
    ];
    const layers: MemoryLayer[] = [];
    for (const layer of entry['layers']) {
      if (typeof layer !== 'string') {
        throw new Error(
          `Parliament: [memory] layers in "${configPath}" must be strings`,
        );
      }
      const upper = layer.toUpperCase() as MemoryLayer;
      if (!validLayers.includes(upper)) {
        throw new Error(
          `Parliament: [memory] layer "${layer}" in "${configPath}" is not one of ${validLayers.join(', ')}`,
        );
      }
      layers.push(upper);
    }
    if (layers.length > 0) out.layers = layers;
  }

  if (provider === 'engram') {
    if (out.endpoint === undefined || out.endpoint.length === 0) {
      throw new Error(
        `Parliament: [memory] provider = "engram" requires an "endpoint" in "${configPath}"`,
      );
    }
    if (out.agent_id === undefined || out.agent_id.length === 0) {
      throw new Error(
        `Parliament: [memory] provider = "engram" requires an "agent_id" in "${configPath}"`,
      );
    }
  }

  return out;
}

/**
 * PAR-38 — instantiates the memory provider declared by the parsed
 * {@link MemoryConfig}. Returns `undefined` for `provider = "none"` so the
 * engine sees a missing field (matching the `memoryProvider?: MemoryProvider`
 * contract on `DeliberationConfig`); `provider = "noop"` returns a
 * `NoopMemoryProvider` instance for tests that want to assert the
 * recall/remember surface is exercised without hitting a network.
 */
export function buildMemoryProvider(config: MemoryConfig): MemoryProvider | undefined {
  switch (config.provider) {
    case 'none':
      return undefined;
    case 'noop':
      return new NoopMemoryProvider();
    case 'engram': {
      const opts: ConstructorParameters<typeof EngramMemoryProvider>[0] = {
        endpoint: config.endpoint!,
      };
      if (config.api_key !== undefined) opts.apiKey = config.api_key;
      if (config.layers !== undefined) opts.layers = config.layers;
      return new EngramMemoryProvider(opts);
    }
  }
}

/**
 * PAR-39 — parses the optional `[context]` table. Missing table → noop default.
 * `provider = "acr"` requires `manifest_path`.
 */
function parseContextConfig(raw: unknown, configPath: string): ContextConfig {
  if (raw === undefined || raw === null) return { ...DEFAULT_CONTEXT_CONFIG };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Parliament: [context] in "${configPath}" must be a TOML table`);
  }

  const entry = raw as Record<string, unknown>;
  const providerRaw = entry['provider'];
  let provider: ContextProviderKind = 'none';
  if (typeof providerRaw === 'string') {
    if (providerRaw === 'none' || providerRaw === 'acr') {
      provider = providerRaw;
    } else {
      throw new Error(
        `Parliament: [context] provider in "${configPath}" must be "none" or "acr" (got "${providerRaw}")`,
      );
    }
  }

  const out: ContextConfig = { provider };
  if (typeof entry['manifest_path'] === 'string') out.manifest_path = entry['manifest_path'];
  if (typeof entry['budget_multiplier'] === 'number') out.budget_multiplier = entry['budget_multiplier'];
  if (typeof entry['cache_ttl_ms'] === 'number') out.cache_ttl_ms = entry['cache_ttl_ms'];

  if (provider === 'acr') {
    if (out.manifest_path === undefined || out.manifest_path.length === 0) {
      throw new Error(
        `Parliament: [context] provider = "acr" requires a "manifest_path" in "${configPath}"`,
      );
    }
  }

  return out;
}

/**
 * PAR-39 — instantiates the context provider declared by {@link ContextConfig}.
 * Returns `undefined` for `provider = "none"` so the engine skips ACR resolution;
 * `provider = "acr"` returns a ready `ACRContextProvider`.
 */
export function buildContextProvider(config: ContextConfig): ContextProvider | undefined {
  switch (config.provider) {
    case 'none':
      return undefined;
    case 'acr':
      return new ACRContextProvider({
        manifestPath: config.manifest_path!,
        ...(config.budget_multiplier !== undefined
          ? { budgetMultiplier: config.budget_multiplier }
          : {}),
        ...(config.cache_ttl_ms !== undefined
          ? { cacheTtlMs: config.cache_ttl_ms }
          : {}),
      });
  }
}

/**
 * Parses the optional `[ideate]` block. Missing → empty `IdeateConfig` so
 * `resolveLineup` falls through to the in-code defaults unchanged.
 *
 * Recognised sub-tables:
 *   [ideate.lineup.cooperative]   — role overrides for cooperative sub-mode
 *   [ideate.lineup.adversarial]   — role overrides for adversarial sub-mode
 *   [ideate.lineup.full]          — role overrides for full sub-mode
 *   [ideate.synth]                — synthesizer model overrides per sub-mode
 *
 * Each entry under [ideate.lineup.<mode>] is `<role> = "<openrouter-model-id>"`.
 * Each entry under [ideate.synth] is `<mode> = "<openrouter-model-id>"`.
 *
 * Validation here is structural only — unknown roles per sub-mode and the
 * "skeptic under cooperative" rule live on `resolveLineup` so the same
 * validation runs whether overrides come from TOML or programmatic callers.
 */
function parseIdeateConfig(raw: unknown, configPath: string): IdeateConfig {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Parliament: [ideate] in "${configPath}" must be a TOML table`);
  }
  const entry = raw as Record<string, unknown>;
  const out: IdeateConfig = {};

  const lineupRaw = entry['lineup'];
  if (lineupRaw !== undefined) {
    if (typeof lineupRaw !== 'object' || lineupRaw === null || Array.isArray(lineupRaw)) {
      throw new Error(
        `Parliament: [ideate.lineup] in "${configPath}" must be a TOML table`,
      );
    }
    const lineupEntry = lineupRaw as Record<string, unknown>;
    const lineup: NonNullable<IdeateConfig['lineup']> = {};
    const validModes: readonly IdeateMode[] = ['cooperative', 'adversarial', 'full'];
    for (const mode of validModes) {
      const modeRaw = lineupEntry[mode];
      if (modeRaw === undefined) continue;
      if (typeof modeRaw !== 'object' || modeRaw === null || Array.isArray(modeRaw)) {
        throw new Error(
          `Parliament: [ideate.lineup.${mode}] in "${configPath}" must be a TOML table`,
        );
      }
      const modeEntry = modeRaw as Record<string, unknown>;
      const overrides: Partial<Record<LineupRole, string>> = {};
      for (const [role, value] of Object.entries(modeEntry)) {
        if (typeof value !== 'string' || value.trim().length === 0) {
          throw new Error(
            `Parliament: [ideate.lineup.${mode}.${role}] in "${configPath}" must be a non-empty string model id`,
          );
        }
        overrides[role as LineupRole] = value;
      }
      if (Object.keys(overrides).length > 0) {
        lineup[mode] = overrides;
      }
    }
    if (Object.keys(lineup).length > 0) out.lineup = lineup;
  }

  const synthRaw = entry['synth'];
  if (synthRaw !== undefined) {
    if (typeof synthRaw !== 'object' || synthRaw === null || Array.isArray(synthRaw)) {
      throw new Error(
        `Parliament: [ideate.synth] in "${configPath}" must be a TOML table`,
      );
    }
    const synthEntry = synthRaw as Record<string, unknown>;
    const synth: NonNullable<IdeateConfig['synth']> = {};
    const validModes: readonly IdeateMode[] = ['cooperative', 'adversarial', 'full'];
    for (const mode of validModes) {
      const value = synthEntry[mode];
      if (value === undefined) continue;
      if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(
          `Parliament: [ideate.synth.${mode}] in "${configPath}" must be a non-empty string model id`,
        );
      }
      synth[mode] = value;
    }
    if (Object.keys(synth).length > 0) out.synth = synth;
  }

  return out;
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
      // PAR-40 — `system_prompt` is now optional in the TOML config; only
      // surface it when supplied so AgentDefinition.systemPrompt stays
      // strictly `string | undefined` (not the empty string).
      ...(neurotype.system_prompt !== undefined
        ? { systemPrompt: neurotype.system_prompt }
        : {}),
    };
  });
}

/**
 * PAR-25 — small helper centralising the "construct a fallback adapter when
 * the neurotype config opts in" rule. Returns `undefined` when
 * `fallback_provider` is absent so the caller can pass the result straight
 * through to `AgentRuntimeOptions.fallbackAdapter` without an extra branch.
 *
 * The model name resolution mirrors the documented contract on
 * `NeurotypeConfig.fallback_model`: the user-supplied fallback model wins;
 * otherwise the primary model name is reused. The adapter factory is the
 * same callback callers already pass to `buildAgentsFromConfig` — no new
 * dependency on the provider-factory module from this layer.
 */
export function buildFallbackAdapter(
  neurotype: NeurotypeConfig,
  adapterFactory: (model: string, provider?: string) => ModelAdapter,
): ModelAdapter | undefined {
  if (neurotype.fallback_provider === undefined) return undefined;
  const model = neurotype.fallback_model ?? neurotype.model;
  return adapterFactory(model, neurotype.fallback_provider);
}
