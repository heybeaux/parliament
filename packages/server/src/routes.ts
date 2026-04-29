import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { z } from 'zod';
import type { Database } from 'better-sqlite3';
import {
  DeliberationEngine,
  ModelConnectionError,
  createAdapter,
  buildAgentsFromConfig,
  loadConfig,
  ProposerAgent,
  SkepticAgent,
  SynthesizerAgent,
  RedAgent,
  SentryAgent,
  DEFAULT_PARLIAMENT_DEFAULTS,
} from '@parliament/core';
import type { DeliberationConfig } from '@parliament/core';
import { saveDeliberation, getDeliberation, listDeliberations } from './db.js';
import { loadServerConfig, type ServerConfig } from './config.js';
import { corsMiddleware } from './middleware/cors.js';
import { bearerAuth, API_KEY_ENV_VAR } from './middleware/auth.js';
import { rateLimit } from './middleware/rateLimit.js';

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const DeliberateBodySchema = z.object({
  topic: z.string().min(1, 'topic must be a non-empty string'),
  config: z
    .object({
      maxRounds: z.number().int().positive().optional(),
      redAgentInterval: z.number().int().positive().optional(),
      confidenceThreshold: z.number().min(0).max(1).optional(),
    })
    .optional(),
});

// ---------------------------------------------------------------------------
// Agent factory helpers
// ---------------------------------------------------------------------------

/**
 * Constructs a full DeliberationConfig.agents object from parliament.toml.
 * Each role maps to the appropriate typed agent class.
 *
 * Note: All Parliament agent classes have their system prompts hardcoded
 * internally — only the adapter is required at construction time.
 */
function buildAgents(): DeliberationConfig['agents'] {
  const config = loadConfig();
  const agentDefs = buildAgentsFromConfig(
    ['proposer', 'skeptic', 'synthesizer', 'redAgent', 'sentry'],
    (model, provider) => createAdapter(model, provider),
    config,
  );

  const defMap = Object.fromEntries(agentDefs.map((d) => [d.name, d]));

  const get = (role: string) => {
    const def = defMap[role];
    if (!def) throw new Error(`Parliament: missing agent definition for role "${role}"`);
    return def;
  };

  const defaults = config.parliament ?? DEFAULT_PARLIAMENT_DEFAULTS;

  return {
    proposer: new ProposerAgent(get('proposer').adapter),
    skeptic: new SkepticAgent(get('skeptic').adapter),
    synthesizer: new SynthesizerAgent(get('synthesizer').adapter),
    redAgent: new RedAgent(get('redAgent').adapter),
    sentry: new SentryAgent(get('sentry').adapter, {
      osiEnabled: defaults.osi_enabled,
      osiSimilarityThreshold: defaults.osi_threshold,
    }),
  };
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export interface CreateRouterOptions {
  /** Server config; defaults to loadServerConfig() at construction time. */
  serverConfig?: ServerConfig;
  /** API key; defaults to process.env[PARLIAMENT_API_KEY] at construction time. */
  apiKey?: string | undefined;
}

export function createRouter(db: Database, options: CreateRouterOptions = {}): Hono {
  const app = new Hono();
  const serverConfig = options.serverConfig ?? loadServerConfig();
  const apiKey =
    options.apiKey !== undefined ? options.apiKey : process.env[API_KEY_ENV_VAR];

  // -------------------------------------------------------------------------
  // CORS — origin allowlist (defaults to localhost variants only).
  // -------------------------------------------------------------------------
  app.use('*', corsMiddleware(serverConfig.cors_origins));

  // -------------------------------------------------------------------------
  // Bearer auth — only enforced when PARLIAMENT_API_KEY is set.
  // -------------------------------------------------------------------------
  app.use('*', bearerAuth(apiKey));

  // -------------------------------------------------------------------------
  // Per-IP rate limit on the expensive /deliberate POST path.
  // -------------------------------------------------------------------------
  const deliberateLimiter = rateLimit({
    concurrent: serverConfig.rate_limit_concurrent,
    perHour: serverConfig.rate_limit_per_hour,
  });
  app.use('/deliberate', async (c, next) => {
    if (c.req.method !== 'POST') return next();
    return deliberateLimiter(c, next);
  });

  // -------------------------------------------------------------------------
  // GET /health
  // -------------------------------------------------------------------------
  app.get('/health', async (c) => {
    const config = loadConfig();
    const roles = ['proposer', 'skeptic', 'synthesizer', 'redAgent', 'sentry'] as const;

    const modelStatuses: Record<string, 'connected' | 'unreachable'> = {};

    // Collect oMLX model lists once (keyed by base URL) to avoid N round-trips.
    const omlxModelCache = new Map<string, Set<string>>();

    async function getOmlxModels(baseUrl: string, apiKey: string): Promise<Set<string>> {
      const cached = omlxModelCache.get(baseUrl);
      if (cached) return cached;
      try {
        const res = await fetch(`${baseUrl}/models`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(5_000),
        });
        if (!res.ok) return new Set();
        const data = (await res.json()) as { data: Array<{ id: string }> };
        const ids = new Set(data.data.map((m) => m.id));
        omlxModelCache.set(baseUrl, ids);
        return ids;
      } catch {
        return new Set();
      }
    }

    await Promise.all(
      roles.map(async (role) => {
        const neurotype = config.neurotypes[role];
        if (!neurotype) {
          modelStatuses[role] = 'unreachable';
          return;
        }

        // For oMLX: check model existence via the models list (instant, no load).
        // For Ollama/LM Studio: do a live generate probe with a short timeout.
        if (neurotype.provider === 'omlx') {
          const baseUrl = process.env['OMLX_BASE_URL'] ?? 'http://127.0.0.1:8000/v1';
          const apiKey = process.env['OMLX_API_KEY'] ?? '12345678';
          const models = await getOmlxModels(baseUrl, apiKey);
          modelStatuses[role] = models.has(neurotype.model) ? 'connected' : 'unreachable';
          return;
        }

        const adapter = createAdapter(neurotype.model, neurotype.provider);
        try {
          await Promise.race([
            adapter.generate('ping', 'respond with ok'),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('timeout')), 5_000),
            ),
          ]);
          modelStatuses[role] = 'connected';
        } catch (err) {
          if (err instanceof ModelConnectionError || err instanceof Error) {
            modelStatuses[role] = 'unreachable';
          } else {
            modelStatuses[role] = 'unreachable';
          }
        }
      }),
    );

    return c.json({ status: 'ok', models: modelStatuses });
  });

  // -------------------------------------------------------------------------
  // POST /deliberate
  // -------------------------------------------------------------------------
  app.post('/deliberate', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const parsed = DeliberateBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'Validation failed', issues: parsed.error.issues }, 400);
    }

    const { topic, config: configOverrides } = parsed.data;

    let agents: DeliberationConfig['agents'];
    let defaults = DEFAULT_PARLIAMENT_DEFAULTS;
    try {
      agents = buildAgents();
      defaults = loadConfig().parliament ?? DEFAULT_PARLIAMENT_DEFAULTS;
    } catch (err) {
      return c.json(
        { error: `Failed to build agents: ${err instanceof Error ? err.message : String(err)}` },
        500,
      );
    }

    const deliberationConfig: DeliberationConfig = {
      maxRounds: configOverrides?.maxRounds ?? defaults.max_rounds,
      redAgentInterval: configOverrides?.redAgentInterval ?? defaults.red_agent_interval,
      confidenceThreshold: configOverrides?.confidenceThreshold ?? defaults.confidence_threshold,
      agents,
    };

    const engine = new DeliberationEngine();

    let result;
    try {
      result = await engine.run(topic, deliberationConfig);
    } catch (err) {
      return c.json(
        { error: `Deliberation failed: ${err instanceof Error ? err.message : String(err)}` },
        500,
      );
    }

    const id = crypto.randomUUID();

    try {
      saveDeliberation(db, id, topic, result);
    } catch (err) {
      return c.json(
        { error: `Failed to persist result: ${err instanceof Error ? err.message : String(err)}` },
        500,
      );
    }

    return c.json({ id, ...result }, 200);
  });

  // -------------------------------------------------------------------------
  // GET /deliberations — list all stored deliberation summaries (newest first).
  // -------------------------------------------------------------------------
  app.get('/deliberations', (c) => {
    try {
      const rows = listDeliberations(db);
      return c.json({ deliberations: rows }, 200);
    } catch (err) {
      return c.json(
        { error: `Database error: ${err instanceof Error ? err.message : String(err)}` },
        500,
      );
    }
  });

  // -------------------------------------------------------------------------
  // GET /transcripts — list transcript JSON files on disk.
  // -------------------------------------------------------------------------
  app.get('/transcripts', (c) => {
    const dir = process.env['PARLIAMENT_TRANSCRIPTS_DIR'] ?? 'transcripts';
    let entries: string[];
    try {
      entries = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    } catch {
      return c.json({ transcripts: [] }, 200);
    }

    const transcripts = entries
      .map((file) => {
        const full = path.join(dir, file);
        let topic = file;
        let created_at = '';
        try {
          const stat = fs.statSync(full);
          created_at = stat.mtime.toISOString();
          const raw = fs.readFileSync(full, 'utf8');
          const parsed = JSON.parse(raw) as { topic?: string };
          if (parsed.topic) topic = parsed.topic;
        } catch {
          // ignore unreadable files
        }
        return { file, topic, created_at };
      })
      .sort((a, b) => b.created_at.localeCompare(a.created_at));

    return c.json({ transcripts }, 200);
  });

  // -------------------------------------------------------------------------
  // GET /transcripts/:file — fetch one transcript file's contents.
  // -------------------------------------------------------------------------
  app.get('/transcripts/:file', (c) => {
    const { file } = c.req.param();
    if (!/^[a-zA-Z0-9._-]+\.json$/.test(file)) {
      return c.json({ error: 'Invalid transcript filename' }, 400);
    }
    const dir = process.env['PARLIAMENT_TRANSCRIPTS_DIR'] ?? 'transcripts';
    const full = path.join(dir, file);
    try {
      const raw = fs.readFileSync(full, 'utf8');
      return c.body(raw, 200, { 'Content-Type': 'application/json' });
    } catch {
      return c.json({ error: `Transcript "${file}" not found` }, 404);
    }
  });

  // -------------------------------------------------------------------------
  // GET /deliberate/:id
  // -------------------------------------------------------------------------
  app.get('/deliberate/:id', (c) => {
    const { id } = c.req.param();

    let result;
    try {
      result = getDeliberation(db, id);
    } catch (err) {
      return c.json(
        { error: `Database error: ${err instanceof Error ? err.message : String(err)}` },
        500,
      );
    }

    if (result === null) {
      return c.json({ error: `Deliberation "${id}" not found` }, 404);
    }

    return c.json(result, 200);
  });

  return app;
}
