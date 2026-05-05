import {
  isBuiltinNeurotype,
  hasBuiltinDefaultPrompt,
  BUILTIN_AGENT_IDS,
} from '../agents/registry.js';
import { BUILTIN_PRESETS } from './presets.js';
import {
  DEFAULT_NEUROTYPE_TEMPERATURE,
  FALLBACK_PRESET_ID,
  type TopologyConfig,
  type TopologyLogger,
  type TopologyPreset,
  type TopologyStep,
  type UserNeurotypeConfig,
  TopologyValidationError,
} from './types.js';

/**
 * ----------------------------------------------------------------------------
 * Topology loader & validator
 * ----------------------------------------------------------------------------
 *
 * Consumes the parsed-TOML object (already-validated `[neurotypes]` shape
 * lives in `config.ts`; this file owns the `[topology]` semantics) and
 * returns a fully-resolved `TopologyConfig`. All hard errors per
 * `add-topology-spec` are raised here as `TopologyValidationError` with
 * stable `code` discriminants.
 *
 * Design notes:
 * - The loader does NOT read the filesystem itself. It takes a parsed
 *   object (`unknown`) so callers can pre-parse via `smol-toml` exactly the
 *   way the existing `config.ts` does.
 * - "Sentry-as-a-step" is enforced after the kebab-case + duplicate-ID
 *   checks, so users get the highest-signal error first. The spec only
 *   requires that this case fail; ordering is implementation freedom.
 * - "Did you mean" suggestions use Levenshtein distance with a threshold of
 *   2 — the spec mandates this exact threshold.
 * - The loader runs at config-load time only. Per the spec's
 *   "Suggestion computation MUST run only at config-load time" rule, we
 *   never re-run distance checks per deliberation.
 * ----------------------------------------------------------------------------
 */

const KEBAB_CASE = /^[a-z][a-z0-9-]*$/;

/**
 * Sentry is structural infrastructure (echo-loop monitor) and is forbidden
 * from preset `steps`. The loader checks against this exact set so that any
 * future infrastructure roles can be added without a code change at every
 * call site.
 */
const FORBIDDEN_STEP_NEUROTYPES: ReadonlySet<string> = new Set(['sentry']);

/** No-op logger used when the caller doesn't supply one. */
const NULL_LOGGER: TopologyLogger = { info: () => undefined };

export interface LoadTopologyOptions {
  /** Optional logger sink for info-level messages (e.g. fallback-to-debate). */
  logger?: TopologyLogger;
}

/**
 * Resolve a parsed-TOML object into a `TopologyConfig`.
 *
 * `parsed` is the object returned by `smol-toml.parse()` (or any TOML
 * parser); it is treated as `unknown` and shape-validated here.
 */
export function loadTopology(
  parsed: unknown,
  options: LoadTopologyOptions = {},
): TopologyConfig {
  const logger = options.logger ?? NULL_LOGGER;

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TopologyValidationError(
      'invalid_topology_shape',
      'parliament.toml: top-level must be a TOML table',
    );
  }

  const top = parsed as Record<string, unknown>;

  // Step 1: parse user-defined neurotypes. We need these BEFORE validating
  // step neurotype references so unknown-neurotype errors fire correctly.
  const userNeurotypes = parseUserNeurotypes(top['neurotypes']);

  // Step 2: parse user-defined presets and merge with built-ins. Collisions
  // between built-in and user-defined preset IDs are a hard error.
  const userPresets = parseUserPresets(top['topology']);
  const presets = mergePresets(BUILTIN_PRESETS, userPresets);

  // Step 3: validate every preset (built-in + user-defined) against the
  // step rules — kebab-case, uniqueness, neurotype resolution, no-Sentry.
  for (const preset of Object.values(presets)) {
    validatePreset(preset, userNeurotypes);
  }

  // Step 4: resolve the active preset name. Absent `[topology]` falls back
  // to `debate` with an info-level log.
  const activeId = parseActiveId(top['topology'], logger);
  const activePreset = presets[activeId];
  if (!activePreset) {
    throw unknownActivePresetError(activeId, presets);
  }

  return Object.freeze({
    activePreset,
    presets: Object.freeze({ ...presets }),
    userNeurotypes: Object.freeze({ ...userNeurotypes }),
  });
}

// ---------------------------------------------------------------------------
// User-defined neurotypes
// ---------------------------------------------------------------------------

function parseUserNeurotypes(raw: unknown): Record<string, UserNeurotypeConfig> {
  if (raw === undefined) return {};
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TopologyValidationError(
      'invalid_neurotype_shape',
      'parliament.toml: [neurotypes] must be a TOML table',
    );
  }

  const result: Record<string, UserNeurotypeConfig> = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new TopologyValidationError(
        'invalid_neurotype_shape',
        `parliament.toml: [neurotypes.${id}] must be a TOML table`,
      );
    }
    const entry = value as Record<string, unknown>;

    if (typeof entry['model'] !== 'string') {
      throw new TopologyValidationError(
        'invalid_neurotype_shape',
        `parliament.toml: [neurotypes.${id}] is missing required field "model"`,
      );
    }
    // PAR-40 — `system_prompt` is required only for user-defined neurotype
    // IDs. Built-in IDs ship a class-level default in `agents/<id>.ts` and
    // may omit the field; when omitted, the agent uses its built-in
    // SYSTEM_PROMPT at runtime. This includes BOTH registry built-ins
    // (proposer, skeptic, …) and structural built-ins (synthesizer,
    // redAgent, sentry) — see `hasBuiltinDefaultPrompt` in registry.ts. A
    // non-string value is still rejected loudly so a typo doesn't silently
    // fall back to the default.
    const promptRaw = entry['system_prompt'];
    if (promptRaw !== undefined && typeof promptRaw !== 'string') {
      throw new TopologyValidationError(
        'invalid_neurotype_shape',
        `parliament.toml: [neurotypes.${id}] field "system_prompt" must be a string`,
      );
    }
    if (promptRaw === undefined && !hasBuiltinDefaultPrompt(id)) {
      throw new TopologyValidationError(
        'invalid_neurotype_shape',
        `parliament.toml: [neurotypes.${id}] is missing required field "system_prompt" (required for user-defined neurotypes; built-ins may omit it to use the default)`,
      );
    }

    const temperature =
      typeof entry['temperature'] === 'number'
        ? entry['temperature']
        : DEFAULT_NEUROTYPE_TEMPERATURE;

    result[id] = {
      model: entry['model'],
      ...(typeof promptRaw === 'string' ? { system_prompt: promptRaw } : {}),
      temperature,
      ...(typeof entry['description'] === 'string' ? { description: entry['description'] } : {}),
      ...(typeof entry['provider'] === 'string' ? { provider: entry['provider'] } : {}),
    };
  }
  return result;
}

// ---------------------------------------------------------------------------
// User-defined presets
// ---------------------------------------------------------------------------

function parseUserPresets(raw: unknown): Record<string, TopologyPreset> {
  if (raw === undefined) return {};
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TopologyValidationError(
      'invalid_topology_shape',
      'parliament.toml: [topology] must be a TOML table',
    );
  }

  const topology = raw as Record<string, unknown>;
  const presetsRaw = topology['presets'];
  if (presetsRaw === undefined) return {};

  if (presetsRaw === null || typeof presetsRaw !== 'object' || Array.isArray(presetsRaw)) {
    throw new TopologyValidationError(
      'invalid_preset_shape',
      'parliament.toml: [topology.presets] must be a TOML table',
    );
  }

  const result: Record<string, TopologyPreset> = {};
  for (const [id, value] of Object.entries(presetsRaw as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new TopologyValidationError(
        'invalid_preset_shape',
        `parliament.toml: [topology.presets.${id}] must be a TOML table`,
      );
    }
    const entry = value as Record<string, unknown>;

    // Required metadata — applies uniformly to user-defined presets per the
    // "Every preset MUST declare required metadata" requirement.
    const missing: string[] = [];
    if (typeof entry['name'] !== 'string') missing.push('name');
    if (typeof entry['description'] !== 'string') missing.push('description');
    if (typeof entry['best_for'] !== 'string') missing.push('best_for');
    if (missing.length > 0) {
      throw new TopologyValidationError(
        'missing_metadata',
        `parliament.toml: [topology.presets.${id}] is missing required metadata: ${missing.join(', ')}`,
      );
    }

    if (!Array.isArray(entry['steps'])) {
      throw new TopologyValidationError(
        'invalid_preset_shape',
        `parliament.toml: [topology.presets.${id}] is missing a steps array`,
      );
    }

    const steps = (entry['steps'] as unknown[]).map((stepRaw, i) =>
      parseStep(stepRaw, id, i, 'steps'),
    );

    // `parallel_steps` is optional and additive (Stage 4). Absent → no-op.
    let parallelSteps: readonly TopologyStep[] | undefined;
    const parallelRaw = entry['parallel_steps'];
    if (parallelRaw !== undefined) {
      if (!Array.isArray(parallelRaw)) {
        throw new TopologyValidationError(
          'invalid_preset_shape',
          `parliament.toml: [topology.presets.${id}].parallel_steps must be an array of step tables`,
        );
      }
      parallelSteps = Object.freeze(
        (parallelRaw as unknown[]).map((stepRaw, i) =>
          parseStep(stepRaw, id, i, 'parallel_steps'),
        ),
      );
    }

    result[id] = {
      id,
      name: entry['name'] as string,
      description: entry['description'] as string,
      best_for: entry['best_for'] as string,
      isBuiltin: false,
      steps: Object.freeze(steps),
      ...(parallelSteps !== undefined ? { parallel_steps: parallelSteps } : {}),
    };
  }
  return result;
}

function parseStep(
  raw: unknown,
  presetId: string,
  index: number,
  block: 'steps' | 'parallel_steps' = 'steps',
): TopologyStep {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TopologyValidationError(
      'invalid_preset_shape',
      `parliament.toml: [topology.presets.${presetId}] ${block} #${index} must be a table`,
    );
  }
  const entry = raw as Record<string, unknown>;

  if (typeof entry['id'] !== 'string') {
    throw new TopologyValidationError(
      'invalid_preset_shape',
      `parliament.toml: [topology.presets.${presetId}] ${block} #${index} is missing string field "id"`,
    );
  }
  if (typeof entry['neurotype'] !== 'string') {
    throw new TopologyValidationError(
      'invalid_preset_shape',
      `parliament.toml: [topology.presets.${presetId}] ${block} #${index} is missing string field "neurotype"`,
    );
  }

  // `optional` defaults to false (strict-by-default per the spec). Setting
  // it explicitly to false is equivalent to omitting it.
  const optional = entry['optional'] === true;

  return Object.freeze({
    id: entry['id'],
    neurotype: entry['neurotype'],
    optional,
  });
}

// ---------------------------------------------------------------------------
// Preset merging + validation
// ---------------------------------------------------------------------------

function mergePresets(
  builtins: Readonly<Record<string, TopologyPreset>>,
  userDefined: Readonly<Record<string, TopologyPreset>>,
): Record<string, TopologyPreset> {
  const merged: Record<string, TopologyPreset> = { ...builtins };
  for (const [id, preset] of Object.entries(userDefined)) {
    if (Object.prototype.hasOwnProperty.call(builtins, id)) {
      throw new TopologyValidationError(
        'preset_id_collision',
        `parliament.toml: user-defined preset "${id}" collides with a built-in preset; pick a different ID`,
      );
    }
    merged[id] = preset;
  }
  return merged;
}

function validatePreset(
  preset: TopologyPreset,
  userNeurotypes: Readonly<Record<string, UserNeurotypeConfig>>,
): void {
  // Track the originating block for each ID so duplicate errors can name
  // both locations — e.g. duplicate id "critique" in steps and parallel_steps.
  const seenIds = new Map<string, 'steps' | 'parallel_steps'>();

  const validateStep = (
    step: TopologyStep,
    block: 'steps' | 'parallel_steps',
  ): void => {
    if (!KEBAB_CASE.test(step.id)) {
      throw new TopologyValidationError(
        'invalid_step_id_format',
        `preset "${preset.id}": step id "${step.id}" violates the kebab-case rule (^[a-z][a-z0-9-]*$)`,
      );
    }

    const previousBlock = seenIds.get(step.id);
    if (previousBlock !== undefined) {
      const where =
        previousBlock === block
          ? `appears twice in ${block}`
          : `appears in both ${previousBlock} and ${block}`;
      throw new TopologyValidationError(
        'duplicate_step_id',
        `preset "${preset.id}": duplicate step id "${step.id}" — ${where}`,
      );
    }
    seenIds.set(step.id, block);

    // Sentry-in-steps rule applies to BOTH sequential and parallel blocks
    // (synthesizer/redAgent/sentry are structural infrastructure regardless
    // of where they're declared).
    if (FORBIDDEN_STEP_NEUROTYPES.has(step.neurotype)) {
      throw new TopologyValidationError(
        'sentry_in_steps',
        `preset "${preset.id}": ${block} entry "${step.id}" references "${step.neurotype}", which is structural infrastructure and cannot be used as a preset step`,
      );
    }

    if (
      !isBuiltinNeurotype(step.neurotype) &&
      !Object.prototype.hasOwnProperty.call(userNeurotypes, step.neurotype)
    ) {
      throw new TopologyValidationError(
        'unknown_neurotype',
        `preset "${preset.id}": ${block} entry "${step.id}" references unknown neurotype "${step.neurotype}". Known built-in IDs: ${BUILTIN_AGENT_IDS.join(', ')}`,
      );
    }
  };

  for (const step of preset.steps) validateStep(step, 'steps');
  if (preset.parallel_steps) {
    for (const step of preset.parallel_steps) validateStep(step, 'parallel_steps');
  }
}

// ---------------------------------------------------------------------------
// Active preset resolution
// ---------------------------------------------------------------------------

function parseActiveId(raw: unknown, logger: TopologyLogger): string {
  if (raw === undefined) {
    logger.info(
      `parliament.toml: no [topology] block found; falling back to "${FALLBACK_PRESET_ID}" preset`,
    );
    return FALLBACK_PRESET_ID;
  }

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TopologyValidationError(
      'invalid_topology_shape',
      'parliament.toml: [topology] must be a TOML table',
    );
  }

  const topology = raw as Record<string, unknown>;
  const active = topology['active'];

  if (active === undefined) {
    logger.info(
      `parliament.toml: [topology] is present but "active" is not set; falling back to "${FALLBACK_PRESET_ID}" preset`,
    );
    return FALLBACK_PRESET_ID;
  }

  if (typeof active !== 'string') {
    throw new TopologyValidationError(
      'invalid_topology_shape',
      'parliament.toml: [topology].active must be a string',
    );
  }

  return active;
}

function unknownActivePresetError(
  unknownId: string,
  presets: Record<string, TopologyPreset>,
): TopologyValidationError {
  const available = Object.keys(presets).sort();
  const closest = closestPresetId(unknownId, available);
  const suggestion = closest ? ` — did you mean "${closest}"?` : '';
  return new TopologyValidationError(
    'unknown_active_preset',
    `parliament.toml: unknown preset "${unknownId}"${suggestion} Available presets: [${available.join(', ')}]`,
  );
}

/**
 * Returns a `TopologyConfig` whose `activePreset` is `overrideId`, leaving
 * the registry and user neurotypes intact.
 *
 * Throws a `TopologyValidationError` (`unknown_active_preset`) with the
 * loader's standard error format — `did you mean "..."?` suggestion plus
 * the alphabetized available list — when `overrideId` isn't registered.
 *
 * Use this when a runtime caller (CLI, server) wants to override the
 * preset chosen by `[topology].active` without re-reading the TOML file.
 */
export function resolveActivePreset(
  config: TopologyConfig,
  overrideId: string,
): TopologyConfig {
  if (overrideId === config.activePreset.id) return config;
  const preset = config.presets[overrideId];
  if (!preset) throw unknownActivePresetError(overrideId, config.presets);
  return { ...config, activePreset: preset };
}

/**
 * Levenshtein-based "did you mean" lookup. Returns the closest available
 * preset ID when its edit distance to `target` is ≤ 2, otherwise returns
 * `null`. The threshold is fixed by the topology spec.
 */
function closestPresetId(target: string, candidates: readonly string[]): string | null {
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const distance = levenshtein(target, candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return bestDistance <= 2 ? best : null;
}

/** Iterative Levenshtein distance with a single rolling row. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j]! + 1, // deletion
        curr[j - 1]! + 1, // insertion
        prev[j - 1]! + substitutionCost, // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }

  return prev[b.length]!;
}
