/**
 * Brainstorm routes — POST /brainstorm, POST /brainstorm/forge, GET /brainstorm/:id.
 *
 * These handlers MUST NOT share the handleIdeate path. The response shape is
 * distinct from the ideation surface: a ranked list of candidate ideas (with
 * per-criterion scores, cluster labels, and optional forge elaborations) rather
 * than a single synthesized output.
 *
 * Fire-and-forget pattern: POST returns 202 + { id, status: 'running' }
 * immediately; the background runner persists phases as they complete and
 * writes the final row on termination. GET reads from the `brainstorms` table
 * only — MUST NOT fall back to `ideations`.
 *
 * Spec: openspec/changes/add-brainstorm-mode/design.md §server-routes.
 */

import { z } from 'zod';
import type { Context, Hono } from 'hono';
import type { Database } from 'better-sqlite3';
import {
  createAdapter,
  runBrainstorm,
  resolveBrainstormLineup,
  resolveRankWeights,
  DEFAULT_RANK_WEIGHTS,
} from '@parliament/core';
import type { BrainstormMode, BrainstormRankWeights } from '@parliament/core';
import {
  buildBrainstormInflightKey,
  brainstormInflight,
  createBrainstormRow,
  finalizeBrainstorm,
  updateBrainstormProgress,
  getBrainstorm,
} from '../brainstorms.js';
import type { RouterVariables } from '../routes.js';
import { AUTH_CTX_ACCOUNT_ID } from '../middleware/auth.js';
import { OSS_ACCOUNT_ID } from '../api-keys.js';

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const RankWeightsSchema = z.object({
  novelty: z.number().positive().optional(),
  feasibility: z.number().positive().optional(),
  fit: z.number().positive().optional(),
  evidence: z.number().positive().optional(),
});

/**
 * POST /brainstorm — divergent generation + dedupe + cluster + rank.
 * Does NOT run forge elaboration.
 */
const BrainstormBodySchema = z.object({
  prompt: z.string().trim().min(1, 'prompt must be a non-empty string'),
  ideas_per_author: z.number().int().min(1).max(20).optional(),
  rank_weights: RankWeightsSchema.optional(),
});

/**
 * POST /brainstorm/forge — same pipeline plus forge elaboration of top-K ideas.
 * Accepts an additional `k` field for the top-K count.
 */
const BrainstormForgeBodySchema = z.object({
  prompt: z.string().trim().min(1, 'prompt must be a non-empty string'),
  ideas_per_author: z.number().int().min(1).max(20).optional(),
  rank_weights: RankWeightsSchema.optional(),
  k: z.number().int().min(1).max(10).optional(),
});

// ---------------------------------------------------------------------------
// Handler builders — each exported so the router can register them separately.
// The spec (tasks.md 9.2) requires two DISTINCT handlers; they share private
// helpers but may never collapse into a single function.
// ---------------------------------------------------------------------------

export function registerBrainstormRoutes(
  app: Hono<RouterVariables>,
  db: Database,
): void {
  app.post('/brainstorm', async (c: Context<RouterVariables>) => {
    return handleBrainstorm(c, db, 'brainstorm');
  });

  app.post('/brainstorm/forge', async (c: Context<RouterVariables>) => {
    return handleBrainstormForge(c, db);
  });

  app.get('/brainstorm/:id', (c: Context<RouterVariables>) => {
    return handleGetBrainstorm(c, db);
  });
}

// ---------------------------------------------------------------------------
// POST /brainstorm
// ---------------------------------------------------------------------------

async function handleBrainstorm(
  c: Context<RouterVariables>,
  db: Database,
  mode: BrainstormMode,
): Promise<Response> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const parsed = BrainstormBodySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', issues: parsed.error.issues }, 400);
  }

  const { prompt, ideas_per_author, rank_weights } = parsed.data;

  return runBrainstormBackground(c, db, {
    prompt,
    mode,
    ideasPerAuthor: ideas_per_author,
    rankWeights: rank_weights,
    forgeK: undefined,
  });
}

// ---------------------------------------------------------------------------
// POST /brainstorm/forge
// ---------------------------------------------------------------------------

async function handleBrainstormForge(
  c: Context<RouterVariables>,
  db: Database,
): Promise<Response> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const parsed = BrainstormForgeBodySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', issues: parsed.error.issues }, 400);
  }

  const { prompt, ideas_per_author, rank_weights, k } = parsed.data;

  return runBrainstormBackground(c, db, {
    prompt,
    mode: 'brainstorm/forge',
    ideasPerAuthor: ideas_per_author,
    rankWeights: rank_weights,
    forgeK: k,
  });
}

// ---------------------------------------------------------------------------
// GET /brainstorm/:id
// ---------------------------------------------------------------------------

function handleGetBrainstorm(c: Context<RouterVariables>, db: Database): Response {
  const { id } = c.req.param();
  let record;
  try {
    record = getBrainstorm(db, id);
  } catch (err) {
    return c.json(
      { error: `Database error: ${err instanceof Error ? err.message : String(err)}` },
      500,
    );
  }
  if (record === null) {
    return c.json({ error: `Brainstorm "${id}" not found` }, 404);
  }
  return c.json(record, 200);
}

// ---------------------------------------------------------------------------
// Shared fire-and-forget runner
// ---------------------------------------------------------------------------

interface BrainstormRunArgs {
  prompt: string;
  mode: BrainstormMode;
  ideasPerAuthor?: number;
  rankWeights?: BrainstormRankWeights;
  forgeK?: number;
}

async function runBrainstormBackground(
  c: Context<RouterVariables>,
  db: Database,
  args: BrainstormRunArgs,
): Promise<Response> {
  const { prompt, mode, ideasPerAuthor, rankWeights, forgeK } = args;

  let lineup;
  let resolvedWeights;
  try {
    // BrainstormConfig is not yet on ParliamentTomlConfig — pass undefined
    // so resolveBrainstormLineup falls back to in-code defaults. Per-run
    // rank_weights from the request body are forwarded as the body override.
    lineup = resolveBrainstormLineup(undefined);
    resolvedWeights = resolveRankWeights(undefined, rankWeights);
  } catch (err) {
    return c.json(
      { error: `Failed to resolve lineup: ${err instanceof Error ? err.message : String(err)}` },
      500,
    );
  }

  const accountId =
    (c.get(AUTH_CTX_ACCOUNT_ID) as string | undefined) ?? OSS_ACCOUNT_ID;

  const inflightKey = buildBrainstormInflightKey({ accountId, prompt, mode });
  const existing = brainstormInflight.lookup(inflightKey);
  if (existing !== null) {
    return c.json({ id: existing, status: 'running' }, 202);
  }

  const id = crypto.randomUUID();
  try {
    createBrainstormRow(db, { id, prompt, mode, lineup });
  } catch (err) {
    return c.json(
      { error: `Failed to persist placeholder: ${err instanceof Error ? err.message : String(err)}` },
      500,
    );
  }
  brainstormInflight.register(inflightKey, id);

  void (async () => {
    try {
      const result = await runBrainstorm(
        {
          prompt,
          mode,
          lineup,
          ideasPerAuthor,
          forgeK,
          weights: resolvedWeights ?? DEFAULT_RANK_WEIGHTS,
        },
        (model) => createAdapter(model),
        {
          onPhase: (phases) => {
            try {
              updateBrainstormProgress(db, id, phases);
            } catch (err) {
              console.error(`Parliament: failed to persist brainstorm phase for ${id}:`, err);
            }
          },
        },
      );
      try {
        finalizeBrainstorm(db, id, {
          status: result.status,
          phases: result.phases,
          rankings: result.rankings,
          elaborations: result.elaborations ?? null,
          error: result.error,
        });
      } catch (err) {
        console.error(`Parliament: failed to finalize brainstorm ${id}:`, err);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      try {
        finalizeBrainstorm(db, id, {
          status: 'error',
          phases: [],
          rankings: [],
          elaborations: null,
          error: message,
        });
      } catch (persistErr) {
        console.error(`Parliament: failed to mark brainstorm ${id} error:`, persistErr);
      }
    } finally {
      brainstormInflight.release(inflightKey);
    }
  })();

  return c.json({ id, status: 'running' }, 202);
}
