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

export interface UserSettings {
  /** OpenRouter API key. Stored verbatim; never logged. */
  openrouter_api_key?: string;
}

export const SETTINGS_PATH = join(homedir(), '.parliament', 'settings.json');

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
    return out;
  } catch {
    return {};
  }
}

/** Reads the persisted settings file (or {} when absent / malformed). */
export function loadSettings(path: string = SETTINGS_PATH): UserSettings {
  return readSettingsFile(path);
}

/**
 * Persists settings, merging over whatever is already on disk so a partial
 * update (e.g. just the OpenRouter key) never clobbers unrelated fields. The
 * file is written 0600 since it holds a secret.
 */
export function saveSettings(
  patch: UserSettings,
  path: string = SETTINGS_PATH,
): UserSettings {
  const current = readSettingsFile(path);
  const next: UserSettings = { ...current, ...patch };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(next, null, 2), { mode: 0o600 });
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
export function applySettingsToEnv(path: string = SETTINGS_PATH): boolean {
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
export function hasOpenRouterKey(path: string = SETTINGS_PATH): boolean {
  const envKey = process.env['OPENROUTER_API_KEY'];
  if (envKey && envKey.length > 0) return true;
  const { openrouter_api_key } = readSettingsFile(path);
  return Boolean(openrouter_api_key && openrouter_api_key.length > 0);
}
