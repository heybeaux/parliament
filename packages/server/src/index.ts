import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { serve } from '@hono/node-server';
import { loadConfig, DEFAULT_PARLIAMENT_DEFAULTS } from '@parliament/core';
import { initDb } from './db.js';
import { createRouter } from './routes.js';
import { loadServerConfig, isPubliclyBound, DEFAULT_DB_PATH } from './config.js';
import { API_KEY_ENV_VAR, API_KEY_UNSET_WARNING } from './middleware/auth.js';

function resolvePort(): number {
  if (process.env['PORT']) return parseInt(process.env['PORT'], 10);
  try {
    return loadConfig().parliament?.server_port ?? DEFAULT_PARLIAMENT_DEFAULTS.server_port;
  } catch {
    return DEFAULT_PARLIAMENT_DEFAULTS.server_port;
  }
}

const serverConfig = loadServerConfig();
const apiKey = process.env[API_KEY_ENV_VAR];

if (!apiKey) {
  console.warn(API_KEY_UNSET_WARNING);
}

if (
  isPubliclyBound(serverConfig.host) &&
  serverConfig.cors_origins.length === 2 &&
  serverConfig.cors_origins.every((o) => o.includes('localhost') || o.includes('127.0.0.1'))
) {
  console.warn(
    `Parliament: server bound to ${serverConfig.host} but cors_origins is still the localhost ` +
      `default. Set [server].cors_origins explicitly in parliament.toml or via ` +
      `PARLIAMENT_CORS_ORIGINS to expose the API to non-loopback clients.`,
  );
}

const dbPath = serverConfig.db_path;

// Ensure the parent directory exists before opening the database.
mkdirSync(dirname(dbPath), { recursive: true });

// One-time legacy migration: when the user hasn't pinned PARLIAMENT_DB_PATH and
// an old `./parliament.db` exists in cwd, hoist it into the new home location
// so prior deliberations remain visible. We never delete the original — the
// operator is expected to clean up once they confirm the move.
const envPathPinned = Boolean(process.env['PARLIAMENT_DB_PATH']);
if (!envPathPinned && dbPath === DEFAULT_DB_PATH) {
  const legacyPath = resolvePath(process.cwd(), 'parliament.db');
  if (existsSync(legacyPath) && !existsSync(dbPath)) {
    copyFileSync(legacyPath, dbPath);
    console.log(
      `Parliament: copied legacy DB ${legacyPath} -> ${dbPath} (original left in place; remove when ready).`,
    );
  }
}

const db = initDb(dbPath);
const app = createRouter(db, { serverConfig, apiKey });

const port = resolvePort();
serve({ fetch: app.fetch, port, hostname: serverConfig.host }, (info) => {
  console.log(`Parliament API listening on http://${serverConfig.host}:${info.port}`);
});
