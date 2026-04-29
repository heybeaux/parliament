/**
 * Server-specific configuration.
 *
 * Reads the `[server]` table from `parliament.toml` (resolved via the same
 * `PARLIAMENT_CONFIG` env var the core loader honours) and applies the
 * following precedence for each field:
 *
 *   1. Environment variable (when set)
 *   2. `[server]` field in parliament.toml
 *   3. Hard-coded secure default
 *
 * Defaults are deliberately conservative: bind to loopback, allow only
 * localhost CORS, no auth required (a startup warning is logged elsewhere
 * when `PARLIAMENT_API_KEY` is unset), and a per-IP rate limit suitable
 * for single-user local development.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'smol-toml';

export interface ServerConfig {
  /** Interface to bind to. Defaults to loopback. Set to 0.0.0.0 only with explicit opt-in. */
  host: string;
  /** Allowed CORS origins (exact strings or `http://localhost:*` / `http://127.0.0.1:*` wildcard forms). */
  cors_origins: string[];
  /** Max concurrent /deliberate requests per client IP. */
  rate_limit_concurrent: number;
  /** Max /deliberate requests per client IP per hour. */
  rate_limit_per_hour: number;
}

export const DEFAULT_SERVER_CONFIG: ServerConfig = {
  host: '127.0.0.1',
  cors_origins: ['http://localhost:*', 'http://127.0.0.1:*'],
  rate_limit_concurrent: 1,
  rate_limit_per_hour: 10,
};

const DEFAULT_CONFIG_FILENAME = 'parliament.toml';

function readServerTable(): Record<string, unknown> {
  const raw = process.env['PARLIAMENT_CONFIG'] ?? DEFAULT_CONFIG_FILENAME;
  const configPath = resolve(process.cwd(), raw);

  let text: string;
  try {
    text = readFileSync(configPath, 'utf-8');
  } catch {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = parse(text);
  } catch {
    return {};
  }

  if (typeof parsed !== 'object' || parsed === null) return {};
  const top = parsed as Record<string, unknown>;
  const server = top['server'];
  if (typeof server !== 'object' || server === null || Array.isArray(server)) {
    return {};
  }
  return server as Record<string, unknown>;
}

/**
 * Loads merged server config: TOML `[server]` table overlaid with env-var overrides.
 * Falls back to {@link DEFAULT_SERVER_CONFIG} for anything missing.
 */
export function loadServerConfig(): ServerConfig {
  const t = readServerTable();
  const cfg: ServerConfig = { ...DEFAULT_SERVER_CONFIG };

  if (typeof t['host'] === 'string') cfg.host = t['host'];
  if (Array.isArray(t['cors_origins']) && t['cors_origins'].every((v) => typeof v === 'string')) {
    cfg.cors_origins = t['cors_origins'] as string[];
  }
  if (typeof t['rate_limit_concurrent'] === 'number') {
    cfg.rate_limit_concurrent = t['rate_limit_concurrent'];
  }
  if (typeof t['rate_limit_per_hour'] === 'number') {
    cfg.rate_limit_per_hour = t['rate_limit_per_hour'];
  }

  // Env-var overrides (highest precedence).
  if (process.env['PARLIAMENT_SERVER_HOST']) {
    cfg.host = process.env['PARLIAMENT_SERVER_HOST'];
  }
  if (process.env['PARLIAMENT_CORS_ORIGINS']) {
    cfg.cors_origins = process.env['PARLIAMENT_CORS_ORIGINS']
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  if (process.env['PARLIAMENT_RATE_LIMIT_CONCURRENT']) {
    const n = parseInt(process.env['PARLIAMENT_RATE_LIMIT_CONCURRENT'], 10);
    if (Number.isFinite(n) && n > 0) cfg.rate_limit_concurrent = n;
  }
  if (process.env['PARLIAMENT_RATE_LIMIT_PER_HOUR']) {
    const n = parseInt(process.env['PARLIAMENT_RATE_LIMIT_PER_HOUR'], 10);
    if (Number.isFinite(n) && n > 0) cfg.rate_limit_per_hour = n;
  }

  return cfg;
}

/** True when host is bound to a non-loopback interface (0.0.0.0, ::, etc). */
export function isPubliclyBound(host: string): boolean {
  return host === '0.0.0.0' || host === '::' || host === '*';
}
