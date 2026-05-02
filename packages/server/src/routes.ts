import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { z } from 'zod';
import type { Database } from 'better-sqlite3';
import {
  DeliberationEngine,
  ModelConnectionError,
  TopologyValidationError,
  createAdapter,
  loadConfig,
  loadTopologyConfig,
  SynthesizerAgent,
  RedAgent,
  SentryAgent,
  StubNeurotypeAgent,
  DEFAULT_PARLIAMENT_DEFAULTS,
  isBuiltinNeurotype,
  createBuiltinAgent,
} from '@parliament/core';
import type {
  Agent,
  DeliberationResult,
  SystemEvent,
  TopologyConfig,
  TopologyDeliberationConfig,
  TopologyStep,
  Turn,
} from '@parliament/core';
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
  /**
   * Optional preset override. When present, takes precedence over
   * `[topology].active` from parliament.toml. Unknown preset → 400.
   *
   * Precedence: request.preset > [topology].active > Debate fallback.
   */
  preset: z.string().min(1).optional(),
  /**
   * Optional free-form prose context the user supplies alongside the topic
   * (PAR-16). When non-empty, the engine prepends it to every non-Sentry
   * agent's user-message turn under a stable `## Background` heading so each
   * agent starts with the same brief. The server echoes the context back
   * unchanged on the response and persists it on the deliberation record so
   * `GET /deliberate/:id` round-trips it.
   *
   * The legacy inline-`CONTEXT:` workaround that pre-PAR-16 callers stuffed
   * into `topic` keeps working unchanged for back-compat — it is documented
   * as deprecated; new callers should use this field instead.
   */
  context: z.string().optional(),
  config: z
    .object({
      maxRounds: z.number().int().positive().optional(),
      redAgentInterval: z.number().int().positive().optional(),
      confidenceThreshold: z.number().min(0).max(1).optional(),
    })
    .optional(),
});

// ---------------------------------------------------------------------------
// Topology runtime wiring
// ---------------------------------------------------------------------------
//
// The server is a thin shell over the topology runtime: every deliberation —
// including the default Debate preset — flows through
// `DeliberationEngine.runTopology`. The legacy hardcoded five-agent pipeline
// (Proposer/Skeptic/Synthesizer/RedAgent/Sentry, fixed wiring) lives only in
// the engine's own byte-identical-debate regression test now.
//
// Three pieces of structural infrastructure remain instantiated directly here
// because the topology runtime takes them as separate inputs (they are
// orthogonal to the preset's `steps`):
//   - Synthesizer — runs end-of-round across every preset.
//   - RedAgent    — out-of-band stress probe at `redAgentInterval`.
//   - Sentry      — out-of-band echo-collapse detector after every step.
//
// Sentry deliberately never appears in any preset's `steps` array; the
// topology loader rejects presets that try to reference it.

/**
 * Resolve a topology preset by ID, applying request-override semantics.
 *
 * Precedence: `requestPreset` > base topology config's active preset.
 * Throws when the requested preset isn't registered (built-in or user-defined).
 */
function resolveActiveTopology(
  base: TopologyConfig,
  requestPreset: string | undefined,
): TopologyConfig {
  if (requestPreset === undefined || requestPreset === base.activePreset.id) {
    return base;
  }
  const preset = base.presets[requestPreset];
  if (!preset) {
    const available = Object.keys(base.presets).sort().join(', ');
    throw new TopologyValidationError(
      'unknown_active_preset',
      `unknown preset "${requestPreset}". Available presets: [${available}]`,
    );
  }
  return { ...base, activePreset: preset };
}

/**
 * Construct the structural-infrastructure trio (Synthesizer / RedAgent /
 * Sentry) the topology runtime needs as separate inputs. These are NOT part
 * of any preset's `steps` — they run unconditionally across every preset.
 *
 * Each agent's adapter is resolved from the matching `[neurotypes.<role>]`
 * entry in `parliament.toml`. A missing neurotype block surfaces as a clear
 * configuration error rather than a silent default.
 */
function buildStructuralAgents(): {
  synthesizer: SynthesizerAgent;
  redAgent: RedAgent;
  sentry: SentryAgent;
} {
  const config = loadConfig();
  const defaults = config.parliament ?? DEFAULT_PARLIAMENT_DEFAULTS;

  const adapterFor = (role: 'synthesizer' | 'redAgent' | 'sentry') => {
    const neurotype = config.neurotypes[role];
    if (!neurotype) {
      throw new Error(
        `Parliament: missing [neurotypes.${role}] entry in parliament.toml; ` +
          `the topology runtime needs this for the structural-infrastructure ${role}.`,
      );
    }
    return createAdapter(neurotype.model, neurotype.provider);
  };

  return {
    synthesizer: new SynthesizerAgent(adapterFor('synthesizer')),
    redAgent: new RedAgent(adapterFor('redAgent')),
    sentry: new SentryAgent(adapterFor('sentry'), {
      osiEnabled: defaults.osi_enabled,
      osiSimilarityThreshold: defaults.osi_threshold,
    }),
  };
}

/**
 * Construct a full TopologyDeliberationConfig from parliament.toml + the
 * resolved topology. Builds a per-step neurotype resolver and the structural
 * synthesizer/redAgent/sentry trio.
 */
function buildTopologyDeliberationConfig(
  topology: TopologyConfig,
  overrides: {
    maxRounds?: number;
    redAgentInterval?: number;
    confidenceThreshold?: number;
    /** PAR-16: optional user-supplied prose context. */
    context?: string;
  },
): TopologyDeliberationConfig {
  const config = loadConfig();
  const defaults = config.parliament ?? DEFAULT_PARLIAMENT_DEFAULTS;

  const structural = buildStructuralAgents();

  // Resolver: per-step, instantiate the appropriate Agent class.
  // Built-in neurotype IDs (proposer, skeptic, historian, ...) come from
  // BUILTIN_AGENT_REGISTRY; user-defined neurotypes fall back to
  // StubNeurotypeAgent until per-neurotype implementations land.
  const resolveNeurotype = (step: TopologyStep): Agent => {
    const neurotype = config.neurotypes[step.neurotype];
    if (!neurotype) {
      throw new Error(
        `Parliament: step "${step.id}" references neurotype "${step.neurotype}" but no [neurotypes.${step.neurotype}] entry exists in parliament.toml`,
      );
    }
    const adapter = createAdapter(neurotype.model, neurotype.provider);
    if (isBuiltinNeurotype(step.neurotype)) {
      return createBuiltinAgent(step.neurotype, adapter);
    }
    return new StubNeurotypeAgent(step.id, step.neurotype, adapter);
  };

  const out: TopologyDeliberationConfig = {
    maxRounds: overrides.maxRounds ?? defaults.max_rounds,
    redAgentInterval: overrides.redAgentInterval ?? defaults.red_agent_interval,
    confidenceThreshold: overrides.confidenceThreshold ?? defaults.confidence_threshold,
    topology,
    resolveNeurotype,
    synthesizer: structural.synthesizer,
    redAgent: structural.redAgent,
    sentry: structural.sentry,
  };
  if (overrides.context !== undefined) {
    out.context = overrides.context;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Response shape — additive Stage 3/4 enrichment
// ---------------------------------------------------------------------------
//
// The server response is the contract the Stage 3 Observability UI consumes:
// every turn carries `model_name`, `neurotype_posture`, `word_count`, and
// `convergence_delta`; the deliberation result carries an `events[]` array.
// The transform here is additive on the wire — old client builds keep
// parsing because no existing field is renamed or removed.
//
// `convergence_delta` semantics, per the Stage 4 elaboration decision on task
// `a3aa8255`:
//   - Round 1 turns → `null` (no prior synthesizer output to compare against).
//   - Round R > 1 → `synth_confidence(R-1) - synth_confidence(R-2)`. We treat
//     "missing" priors as 0 so round 2's delta equals round 1's confidence.
//   - This is the change-in-confidence the room moved through coming INTO
//     this round, attached uniformly to every turn in the round so the UI
//     can render a "room movement" badge per turn card without recomputing.

interface EnrichedTurn extends Turn {
  /** Mirrors `turn.model` under the contract's wire-name. Always populated. */
  model_name: string;
  /** Mirrors `turn.neurotype` under the contract's wire-name (e.g. "epistemic/evidence-first"). */
  neurotype_posture: string;
  /** Whitespace-delimited word count. Pre-Stage-3 stored turns may lack `word_count`; we fall back to recomputing. */
  word_count: number;
  /** Per-round convergence delta. Null on round 1 per the elaboration decision. */
  convergence_delta: number | null;
}

interface EnrichedDeliberationResult extends Omit<DeliberationResult, 'turns'> {
  turns: EnrichedTurn[];
  events: SystemEvent[];
}

/**
 * Whitespace-delimited word count fallback — used only for stored turns that
 * pre-date the engine's `word_count` population.
 */
function countWords(content: string): number {
  const trimmed = content.trim();
  if (trimmed.length === 0) return 0;
  return trimmed.split(/\s+/).length;
}

/**
 * Build a per-round map of synthesizer confidence so we can compute
 * `convergence_delta` without re-walking turns for every record.
 */
function buildSynthConfidenceByRound(turns: readonly Turn[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const turn of turns) {
    if (turn.agent === 'Synthesizer' && turn.meta !== undefined) {
      out.set(turn.round, turn.meta.confidence);
    }
  }
  return out;
}

/**
 * Compute the per-round convergence delta for a given round.
 *
 * Definition: how the synthesizer's confidence shifted going INTO this round.
 *   delta(R) = synth_confidence(R-1) - synth_confidence(R-2)
 *
 * Round 1 → null (per elaboration decision: there is no R-1 synth to compare).
 * Missing R-2 (i.e. R = 2) → treat as 0, so delta is just synth(R-1).
 */
function computeConvergenceDelta(
  round: number,
  synthByRound: Map<number, number>,
): number | null {
  if (round <= 1) return null;
  const prior = synthByRound.get(round - 1) ?? null;
  const before = synthByRound.get(round - 2) ?? 0;
  if (prior === null) return null;
  return Number((prior - before).toFixed(4));
}

/**
 * Apply additive Stage 3 enrichment to a DeliberationResult so the response
 * matches the UI contract.
 *
 * Tolerant of stored rows that pre-date Stage 3: missing `events`, missing
 * `word_count`, and turns without `parallel_group` all degrade gracefully.
 */
function enrichResult(result: DeliberationResult): EnrichedDeliberationResult {
  const synthByRound = buildSynthConfidenceByRound(result.turns);

  const turns: EnrichedTurn[] = result.turns.map((turn) => {
    const wordCount = turn.word_count ?? countWords(turn.content);
    return {
      ...turn,
      word_count: wordCount,
      model_name: turn.model,
      neurotype_posture: turn.neurotype,
      convergence_delta: computeConvergenceDelta(turn.round, synthByRound),
    };
  });

  return {
    ...result,
    turns,
    events: result.events ?? [],
  };
}

// ---------------------------------------------------------------------------
// Preset availability — `requires_neurotypes` / `missing_neurotypes`
// ---------------------------------------------------------------------------
//
// Per Stage 4 server contract: each preset entry exposes the union of
// neurotype IDs referenced by its `steps` and `parallel_steps`, plus the
// subset that are currently un-registered (neither built-in nor defined under
// `[neurotypes.<id>]`).
//
// Caching strategy: validation walks every step of every preset against the
// registry, which is wasted work if neither the preset registry nor the
// user-defined neurotype set has changed. We hash the relevant subset of the
// resolved `TopologyConfig` and memoize the enriched preset list against that
// hash. A config reload changes the hash and forces a recompute; otherwise we
// reuse the prior result on every request.

interface PresetStepShape {
  id: string;
  neurotype: string;
  optional: boolean;
}

interface EnrichedPreset {
  id: string;
  name: string;
  description: string;
  best_for: string;
  isBuiltin: boolean;
  steps: PresetStepShape[];
  parallel_steps?: PresetStepShape[];
  requires_neurotypes: string[];
  missing_neurotypes: string[];
}

/**
 * Stable signature of the inputs that affect availability. Two configs with
 * the same signature MUST produce identical enriched output, so we can reuse
 * the cached result. Order-stable: keys are sorted so a re-parse of the same
 * file produces the same string.
 */
function topologySignature(topology: TopologyConfig): string {
  const presetEntries = Object.keys(topology.presets)
    .sort()
    .map((id) => {
      const p = topology.presets[id]!;
      const seq = p.steps.map((s) => `${s.id}:${s.neurotype}:${s.optional}`).join(',');
      const par =
        p.parallel_steps !== undefined
          ? p.parallel_steps.map((s) => `${s.id}:${s.neurotype}:${s.optional}`).join(',')
          : '';
      return `${id}|${seq}|${par}`;
    })
    .join(';');
  const userKeys = Object.keys(topology.userNeurotypes).sort().join(',');
  return `presets=${presetEntries}#users=${userKeys}`;
}

/**
 * Module-level cache for the enriched preset list. Survives across requests
 * within a single process so consecutive GET /presets calls reuse the work.
 */
interface AvailabilityCache {
  signature: string;
  presets: EnrichedPreset[];
  defaultPreset: string;
  computeCount: number;
}
let presetAvailabilityCache: AvailabilityCache | null = null;

/**
 * Test seam — call between tests to force a fresh recompute on the next
 * GET /presets request.
 */
export function __resetPresetAvailabilityCache(): void {
  presetAvailabilityCache = null;
}

/**
 * Test seam — read the number of times we have actually walked the registry
 * since the cache was last cleared. Used by the AC3 cache test to assert that
 * back-to-back requests do NOT recompute.
 */
export function __getPresetAvailabilityComputeCount(): number {
  return presetAvailabilityCache?.computeCount ?? 0;
}

function buildEnrichedPresets(topology: TopologyConfig): EnrichedPreset[] {
  const userKeys = new Set(Object.keys(topology.userNeurotypes));
  return Object.values(topology.presets).map((p) => {
    const allSteps = [...p.steps, ...(p.parallel_steps ?? [])];
    // Preserve declaration order while de-duplicating shared neurotype refs.
    const requires: string[] = [];
    const seen = new Set<string>();
    for (const step of allSteps) {
      if (!seen.has(step.neurotype)) {
        seen.add(step.neurotype);
        requires.push(step.neurotype);
      }
    }
    const missing = requires.filter(
      (id) => !isBuiltinNeurotype(id) && !userKeys.has(id),
    );

    const enriched: EnrichedPreset = {
      id: p.id,
      name: p.name,
      description: p.description,
      best_for: p.best_for,
      isBuiltin: p.isBuiltin,
      steps: p.steps.map((s) => ({
        id: s.id,
        neurotype: s.neurotype,
        optional: s.optional,
      })),
      requires_neurotypes: requires,
      missing_neurotypes: missing,
    };
    if (p.parallel_steps !== undefined) {
      enriched.parallel_steps = p.parallel_steps.map((s) => ({
        id: s.id,
        neurotype: s.neurotype,
        optional: s.optional,
      }));
    }
    return enriched;
  });
}

function getPresetAvailability(topology: TopologyConfig): {
  presets: EnrichedPreset[];
  defaultPreset: string;
} {
  const signature = topologySignature(topology);
  const cached = presetAvailabilityCache;
  if (cached !== null && cached.signature === signature) {
    return { presets: cached.presets, defaultPreset: cached.defaultPreset };
  }
  const presets = buildEnrichedPresets(topology);
  const defaultPreset = topology.activePreset.id;
  presetAvailabilityCache = {
    signature,
    presets,
    defaultPreset,
    computeCount: (cached?.computeCount ?? 0) + 1,
  };
  return { presets, defaultPreset };
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
  // GET /presets — full topology preset registry plus the resolved default.
  //
  // Response shape: { presets: EnrichedPreset[], defaultPreset: string }.
  // Each preset entry carries `requires_neurotypes` / `missing_neurotypes` so
  // the UI can grey out presets whose required neurotypes are not currently
  // registered. The availability map is cached against a signature of the
  // resolved topology — see `topologySignature` above for the cache key.
  // -------------------------------------------------------------------------
  app.get('/presets', (c) => {
    let topology: TopologyConfig;
    try {
      topology = loadTopologyConfig();
    } catch (err) {
      if (err instanceof TopologyValidationError) {
        return c.json({ error: err.message, code: err.code }, 500);
      }
      return c.json(
        { error: `Failed to load topology: ${err instanceof Error ? err.message : String(err)}` },
        500,
      );
    }
    const { presets, defaultPreset } = getPresetAvailability(topology);
    return c.json({ presets, defaultPreset }, 200);
  });

  // -------------------------------------------------------------------------
  // POST /deliberate
  //
  // Preset precedence (per Stage 1 elaboration decision):
  //   request.preset > [topology].active in parliament.toml > Debate fallback.
  //
  // Every deliberation — including the default Debate preset — flows through
  // `runTopology()`. The legacy hardcoded five-agent `run()` path is gone;
  // `runTopology(active=debate)` is byte-identical to the pre-refactor Debate
  // pipeline (pinned by the engine's `byte-identical-debate.test.ts`).
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

    const {
      topic,
      preset: requestPreset,
      context: requestContext,
      config: configOverrides,
    } = parsed.data;

    let topology: TopologyConfig;
    try {
      topology = loadTopologyConfig();
    } catch (err) {
      if (err instanceof TopologyValidationError) {
        return c.json({ error: err.message, code: err.code }, 500);
      }
      return c.json(
        { error: `Failed to load topology: ${err instanceof Error ? err.message : String(err)}` },
        500,
      );
    }

    let resolvedTopology: TopologyConfig;
    try {
      resolvedTopology = resolveActiveTopology(topology, requestPreset);
    } catch (err) {
      // Unknown request preset → 400 (client error, not server error).
      if (err instanceof TopologyValidationError) {
        return c.json({ error: err.message, code: err.code }, 400);
      }
      return c.json(
        { error: `Failed to resolve preset: ${err instanceof Error ? err.message : String(err)}` },
        500,
      );
    }

    const engine = new DeliberationEngine();
    let result;
    try {
      const topologyConfig = buildTopologyDeliberationConfig(resolvedTopology, {
        maxRounds: configOverrides?.maxRounds,
        redAgentInterval: configOverrides?.redAgentInterval,
        confidenceThreshold: configOverrides?.confidenceThreshold,
        // PAR-16: forward the user-supplied prose context (when present) so
        // the engine prepends it to every non-Sentry agent's user prompt
        // and echoes it back unchanged on the result.
        ...(requestContext !== undefined ? { context: requestContext } : {}),
      });
      result = await engine.runTopology(topic, topologyConfig);
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

    return c.json({ id, ...enrichResult(result) }, 200);
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

    return c.json(enrichResult(result), 200);
  });

  return app;
}
