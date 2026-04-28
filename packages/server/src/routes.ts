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
import { saveDeliberation, getDeliberation } from './db.js';

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
    (model) => createAdapter(model),
    config,
  );

  const defMap = Object.fromEntries(agentDefs.map((d) => [d.name, d]));

  const get = (role: string) => {
    const def = defMap[role];
    if (!def) throw new Error(`Parliament: missing agent definition for role "${role}"`);
    return def;
  };

  return {
    proposer: new ProposerAgent(get('proposer').adapter),
    skeptic: new SkepticAgent(get('skeptic').adapter),
    synthesizer: new SynthesizerAgent(get('synthesizer').adapter),
    redAgent: new RedAgent(get('redAgent').adapter),
    sentry: new SentryAgent(get('sentry').adapter),
  };
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function createRouter(db: Database): Hono {
  const app = new Hono();

  // -------------------------------------------------------------------------
  // GET /health
  // -------------------------------------------------------------------------
  app.get('/health', async (c) => {
    const config = loadConfig();
    const roles = ['proposer', 'skeptic', 'synthesizer', 'redAgent', 'sentry'] as const;

    const modelStatuses: Record<string, 'connected' | 'unreachable'> = {};

    await Promise.all(
      roles.map(async (role) => {
        const neurotype = config.neurotypes[role];
        if (!neurotype) {
          modelStatuses[role] = 'unreachable';
          return;
        }

        const adapter = createAdapter(neurotype.model);
        try {
          // Lightweight connectivity probe — short response expected
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
