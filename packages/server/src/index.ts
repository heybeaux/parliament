import { serve } from '@hono/node-server';
import { loadConfig, DEFAULT_PARLIAMENT_DEFAULTS } from '@parliament/core';
import { initDb } from './db.js';
import { createRouter } from './routes.js';

function resolvePort(): number {
  if (process.env['PORT']) return parseInt(process.env['PORT'], 10);
  try {
    return loadConfig().parliament?.server_port ?? DEFAULT_PARLIAMENT_DEFAULTS.server_port;
  } catch {
    return DEFAULT_PARLIAMENT_DEFAULTS.server_port;
  }
}

const db = initDb();
const app = createRouter(db);

serve({ fetch: app.fetch, port: resolvePort() }, (info) => {
  console.log(`Parliament API listening on http://localhost:${info.port}`);
});
