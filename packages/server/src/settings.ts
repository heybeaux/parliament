/**
 * Runtime user settings — persisted to `~/.parliament/settings.json`.
 *
 * This is the desktop / non-technical path for configuring secrets the engine
 * needs at runtime (today: the OpenRouter API key). The CLI / power users can
 * still set `OPENROUTER_API_KEY` in the environment; when both are present the
 * environment wins so an explicit shell export is never silently overridden by
 * a stale settings file.
 *
 * The factory in `@parliament/core` (`createAdapter`) reads
 * `process.env.OPENROUTER_API_KEY`, so applying a saved key is simply a matter
 * of writing it back into `process.env` at boot and whenever it's updated via
 * the settings API. That keeps the change additive — no core adapter wiring
 * touched.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * The five roles whose models the desktop Settings panel can override. These
 * are exactly the roles the Debate preset + structural infrastructure runs —
 * the set the /health probe reports on.
 */
export const MODEL_OVERRIDE_ROLES = [
  'proposer',
  'skeptic',
  'synthesizer',
  'redAgent',
  'sentry',
] as const;

export type ModelOverrideRole = (typeof MODEL_OVERRIDE_ROLES)[number];

export type ModelOverrides = Partial<Record<ModelOverrideRole, string>>;

export interface UserSettings {
  /** OpenRouter API key. Stored verbatim; never logged. */
  openrouter_api_key?: string;
  /**
   * Per-role model overrides picked in the desktop Settings panel. Each entry
   * replaces the `model` field of the matching `[neurotypes.<role>]` TOML
   * entry at agent-construction time; a missing entry means "use the config
   * default". Only the five roles above are recognised — anything else in the
   * file is dropped on read (same forgiving posture as the key parsing).
   */
  model_overrides?: ModelOverrides;
}

export const SETTINGS_PATH = join(homedir(), '.parliament', 'settings.json');

/**
 * Resolved settings-file path. `PARLIAMENT_SETTINGS_PATH` (used by tests and
 * power users) beats the default `~/.parliament/settings.json`.
 */
export function settingsPath(): string {
  const env = process.env['PARLIAMENT_SETTINGS_PATH'];
  return env && env.length > 0 ? env : SETTINGS_PATH;
}

/**
 * Validates a raw `model_overrides` value from disk (or a request body):
 * unknown roles and non-string / empty values are silently dropped so a
 * hand-edited or stale settings file can never break agent construction.
 */
export function sanitizeModelOverrides(raw: unknown): ModelOverrides {
  const out: ModelOverrides = {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out;
  const obj = raw as Record<string, unknown>;
  for (const role of MODEL_OVERRIDE_ROLES) {
    const value = obj[role];
    if (typeof value === 'string' && value.trim().length > 0) {
      out[role] = value.trim();
    }
  }
  return out;
}

function readSettingsFile(path: string): UserSettings {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    const obj = parsed as Record<string, unknown>;
    const out: UserSettings = {};
    if (typeof obj['openrouter_api_key'] === 'string') {
      out.openrouter_api_key = obj['openrouter_api_key'];
    }
    const overrides = sanitizeModelOverrides(obj['model_overrides']);
    if (Object.keys(overrides).length > 0) {
      out.model_overrides = overrides;
    }
    return out;
  } catch {
    return {};
  }
}

/** Reads the persisted settings file (or {} when absent / malformed). */
export function loadSettings(path: string = settingsPath()): UserSettings {
  return readSettingsFile(path);
}

/**
 * Persists settings, merging over whatever is already on disk so a partial
 * update (e.g. just the OpenRouter key) never clobbers unrelated fields. The
 * file is written 0600 since it holds a secret.
 */
export function saveSettings(
  patch: UserSettings,
  path: string = settingsPath(),
): UserSettings {
  const current = readSettingsFile(path);
  const next: UserSettings = { ...current, ...patch };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

/**
 * Merges a model-override patch into the persisted settings. Semantics per
 * role: a non-empty string sets the override; `null` / empty string clears it
 * back to the config default; an absent key leaves the current value alone.
 * Returns the full override map now on disk.
 */
export function saveModelOverrides(
  patch: Partial<Record<ModelOverrideRole, string | null>>,
  path: string = settingsPath(),
): ModelOverrides {
  const current = readSettingsFile(path).model_overrides ?? {};
  const next: ModelOverrides = { ...current };
  for (const role of MODEL_OVERRIDE_ROLES) {
    if (!(role in patch)) continue;
    const value = patch[role];
    if (typeof value === 'string' && value.trim().length > 0) {
      next[role] = value.trim();
    } else {
      delete next[role];
    }
  }
  saveSettings({ model_overrides: next }, path);
  return next;
}

/**
 * Applies the saved OpenRouter key into `process.env` so the core adapter
 * factory picks it up. An existing non-empty `OPENROUTER_API_KEY` env var is
 * left untouched (explicit env wins over the settings file).
 *
 * Returns true when a key is now present in the environment (from either
 * source), false otherwise.
 */
export function applySettingsToEnv(path: string = settingsPath()): boolean {
  const envKey = process.env['OPENROUTER_API_KEY'];
  if (envKey && envKey.length > 0) return true;

  const { openrouter_api_key } = readSettingsFile(path);
  if (openrouter_api_key && openrouter_api_key.length > 0) {
    process.env['OPENROUTER_API_KEY'] = openrouter_api_key;
    return true;
  }
  return false;
}

/** True when an OpenRouter key is available from env or the settings file. */
export function hasOpenRouterKey(path: string = settingsPath()): boolean {
  const envKey = process.env['OPENROUTER_API_KEY'];
  if (envKey && envKey.length > 0) return true;
  const { openrouter_api_key } = readSettingsFile(path);
  return Boolean(openrouter_api_key && openrouter_api_key.length > 0);
}
