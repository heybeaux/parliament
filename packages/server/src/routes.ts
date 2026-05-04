import { timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { Database } from 'better-sqlite3';
import {
  DeliberationEngine,
  ModelConnectionError,
  Retrying5xxAdapter,
  TopologyValidationError,
  UpstreamProviderError,
  buildFallbackAdapter,
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
  AgentRuntimeOptions,
  DeliberationResult,
  DeliberationSource,
  DeliberationStatus,
  ModelAdapter,
  NeurotypeResolverContext,
  SystemEvent,
  TopologyConfig,
  TopologyDeliberationConfig,
  TopologyStep,
  Turn,
} from '@parliament/core';
import {
  getDeliberation,
  listDeliberations,
  createDeliberationRow,
  appendTurn,
  appendEvent,
  markCompleted,
  markFailed,
} from './db.js';
import { inflightBroker, type InflightEvent } from './inflight.js';
import { loadServerConfig, type ServerConfig } from './config.js';
import { corsMiddleware } from './middleware/cors.js';
import { bearerAuth } from './middleware/auth.js';
import { rateLimit } from './middleware/rateLimit.js';
import { testKeyThrottle } from './middleware/keyThrottle.js';
import {
  createApiKey,
  getApiKey,
  listApiKeys,
  OSS_ACCOUNT_ID,
  revokeApiKey,
} from './api-keys.js';

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

/**
 * PAR-17 — single structured source entry on `POST /deliberate`. The shape
 * mirrors `DeliberationSource` from the engine; we mint a separate zod
 * schema rather than importing one from the core package because zod is
 * already wired into the server's validation surface and the engine type is
 * a plain interface (no runtime validator).
 *
 * Validation rules:
 *   - `id`, `title`, `content` are required and non-empty (whitespace-trimmed
 *     emptiness is rejected). The id is what the agent will quote in
 *     `[brackets]` so a blank id would render `[]` and break citation
 *     stability; the title is what the UI Sources panel displays; the
 *     content is the prose the engine sees in the prompt.
 *   - `kind` is the optional taxonomy hint — restricted to the engine's
 *     fixed enum so the UI's chip rendering stays exhaustive.
 */
const DeliberationSourceSchema = z.object({
  id: z.string().trim().min(1, 'source id must be a non-empty string'),
  title: z.string().trim().min(1, 'source title must be a non-empty string'),
  content: z.string().min(1, 'source content must be a non-empty string'),
  kind: z.enum(['paper', 'memo', 'code', 'transcript', 'other']).optional(),
});

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
  /**
   * Optional structured sources (PAR-17). When non-empty, the engine renders
   * them under a stable `## Sources` heading on every non-Sentry agent's
   * user prompt and the Empiricist activates evidence-backed claim mode.
   * Echoed back unchanged on the response and persisted in `result_json`
   * so `GET /deliberate/:id` round-trips them. Coexists with `context`.
   */
  sources: z.array(DeliberationSourceSchema).optional(),
  config: z
    .object({
      maxRounds: z.number().int().positive().optional(),
      redAgentInterval: z.number().int().positive().optional(),
      confidenceThreshold: z.number().min(0).max(1).optional(),
      /**
       * PAR-17 — per-source word cap. Defaults to 500 in the engine when
       * absent. Must be a positive integer.
       */
      maxSourceWords: z.number().int().positive().optional(),
    })
    .optional(),
  /**
   * PAR-32 / PRD D2 — opt-in transformations. All flags default to `false`,
   * preserving Parliament's "error-forwarding by default" contract: upstream
   * provider failures surface verbatim to the caller with the upstream
   * status, body, and request_id intact rather than being silently retried,
   * masked, or rewritten.
   *
   * Enabling a flag is a deliberate choice the caller makes to trade
   * fidelity for ergonomics — see field comments for the specific trade.
   */
  transform: z
    .object({
      /**
       * When `true`, retry the upstream call exactly once with a short
       * (~250ms) delay if the first attempt fails with HTTP 5xx. Off by
       * default because retries can mask intermittent provider issues that
       * the operator should know about (e.g. a model that's been silently
       * downgraded under capacity pressure).
       *
       * 4xx responses (auth, validation, model-not-found) are never
       * retried — they're deterministic.
       */
      retry_on_upstream_500: z.boolean().optional(),
      /**
       * Reserved for v1.0 — when `true`, the synthesizer's output is
       * coerced to a JSON-schema-validated shape with one validation-retry
       * loop. Off by default because the validator adds latency and may
       * fail on otherwise-useful prose. The flag is accepted now so SDK
       * authors can wire it without a breaking change later; the behaviour
       * gate lands with the synthesizer schema work in M2.
       */
      structured_output: z.boolean().optional(),
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
function buildStructuralAgents(
  /**
   * PAR-32 / PRD D2 — adapter factory the caller passes through so the
   * structural agents (synthesizer / redAgent / sentry) inherit any
   * adapter decoration (e.g. `transform.retry_on_upstream_500`) the
   * deliberation request opted in to. Default factory (`createAdapter`)
   * preserves the pre-PAR-32 unwrapped behaviour for the few non-route
   * call sites that don't pass one.
   */
  factory: (model: string, provider?: string) => ModelAdapter = createAdapter,
): {
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
    return factory(neurotype.model, neurotype.provider);
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
    /** PAR-17: optional structured sources forwarded from the request body. */
    sources?: DeliberationSource[];
    /** PAR-17: per-source word cap forwarded from the request body. */
    maxSourceWords?: number;
    /**
     * PAR-32 / PRD D2 — optional decorator applied to every adapter the
     * resolver constructs. Used to opt the deliberation into the
     * `transform.retry_on_upstream_500` retry-on-5xx wrapper. Default
     * (`undefined`) leaves adapters unwrapped — no retries — preserving
     * the error-forwarding default.
     */
    adapterDecorator?: (adapter: ModelAdapter) => ModelAdapter;
  },
): TopologyDeliberationConfig {
  const config = loadConfig();
  const defaults = config.parliament ?? DEFAULT_PARLIAMENT_DEFAULTS;

  const decorate = overrides.adapterDecorator ?? ((a: ModelAdapter) => a);
  const decoratedFactory = (model: string, provider?: string): ModelAdapter =>
    decorate(createAdapter(model, provider));

  const structural = buildStructuralAgents(decoratedFactory);

  // Resolver: per-step, instantiate the appropriate Agent class.
  // Built-in neurotype IDs (proposer, skeptic, historian, ...) come from
  // BUILTIN_AGENT_REGISTRY; user-defined neurotypes fall back to
  // StubNeurotypeAgent until per-neurotype implementations land.
  //
  // PAR-25 — when the neurotype's TOML entry has `fallback_provider` set,
  // we construct a fallback adapter via `buildFallbackAdapter` and forward
  // it (plus the engine's `onProviderFailover` callback from `context`)
  // into the agent's `AgentRuntimeOptions`. Resolvers that don't pass a
  // context (older test fixtures) get failover-disabled agents — the
  // primary adapter behaviour is unchanged.
  const resolveNeurotype = (
    step: TopologyStep,
    context?: NeurotypeResolverContext,
  ): Agent => {
    const neurotype = config.neurotypes[step.neurotype];
    if (!neurotype) {
      throw new Error(
        `Parliament: step "${step.id}" references neurotype "${step.neurotype}" but no [neurotypes.${step.neurotype}] entry exists in parliament.toml`,
      );
    }
    const adapter = decoratedFactory(neurotype.model, neurotype.provider);
    const fallbackAdapter = buildFallbackAdapter(neurotype, decoratedFactory);
    const options: AgentRuntimeOptions = {};
    if (fallbackAdapter !== undefined) {
      options.fallbackAdapter = fallbackAdapter;
    }
    if (context?.onProviderFailover !== undefined) {
      options.onProviderFailover = context.onProviderFailover;
    }
    if (isBuiltinNeurotype(step.neurotype)) {
      return createBuiltinAgent(step.neurotype, adapter, options);
    }
    return new StubNeurotypeAgent(step.id, step.neurotype, adapter, options);
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
  if (overrides.sources !== undefined && overrides.sources.length > 0) {
    out.sources = overrides.sources;
  }
  if (overrides.maxSourceWords !== undefined) {
    out.maxSourceWords = overrides.maxSourceWords;
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
  /**
   * PAR-18 — lifecycle status surfaced on every GET. Always populated so
   * `in_flight` / `completed` / `failed` is observable without parsing
   * lower-level fields. Pre-PAR-18 stored rows surface `'completed'` (the
   * legacy default applied by `getDeliberation`).
   */
  status: DeliberationStatus;
  /**
   * PAR-18 — only present when `status === 'failed'`.
   */
  error?: string;
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
    // PAR-23: `turn.meta` now also carries adapter telemetry, so a
    // synthesizer-shaped record may co-mingle latency/tokens with the
    // structured fields. Guard explicitly on `confidence` being a number
    // before reading — non-synth rows that picked up adapter meta only
    // (and any future shape drift) leave `confidence` undefined.
    if (
      turn.agent === 'Synthesizer' &&
      turn.meta !== undefined &&
      typeof turn.meta.confidence === 'number'
    ) {
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

  // PAR-18: surface a coherent status on every response. `getDeliberation`
  // already maps NULL columns to `'completed'` for pre-PAR-18 rows; we
  // just defend in depth here so any caller who hands us a result without
  // status (e.g. tests that build the value inline) still gets a sane
  // default.
  const status: DeliberationStatus = result.status ?? 'completed';

  const enriched: EnrichedDeliberationResult = {
    ...result,
    turns,
    events: result.events ?? [],
    status,
  };
  if (result.error !== undefined) {
    enriched.error = result.error;
  }
  return enriched;
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
  /**
   * PAR-33 / M1 T1.1 — admin secret guarding `POST/DELETE /dashboard/api/keys`.
   * Defaults to `process.env.PARLIAMENT_ADMIN_KEY`. When unset, the dashboard
   * key-management endpoints return 403; the `/deliberate` surface still
   * works for any caller whose key already exists in the DB.
   */
  adminKey?: string | undefined;
}

export const ADMIN_KEY_ENV_VAR = 'PARLIAMENT_ADMIN_KEY';

export function createRouter(db: Database, options: CreateRouterOptions = {}): Hono {
  const app = new Hono();
  const serverConfig = options.serverConfig ?? loadServerConfig();
  const adminKey =
    options.adminKey !== undefined ? options.adminKey : process.env[ADMIN_KEY_ENV_VAR];

  // -------------------------------------------------------------------------
  // CORS — origin allowlist (defaults to localhost variants only).
  // -------------------------------------------------------------------------
  app.use('*', corsMiddleware(serverConfig.cors_origins));

  // -------------------------------------------------------------------------
  // PAR-33 — DB-backed bearer auth. Empty `api_keys` table → unauthenticated
  // pass-through (matches OSS self-host parity in API.md). Once any key is
  // created, every non-OPTIONS request must carry `Authorization: Bearer pk_…`.
  //
  // Skipped on `/dashboard/*` because those endpoints carry their own admin
  // secret in `Authorization: Bearer <PARLIAMENT_ADMIN_KEY>` and must remain
  // reachable even after the first per-account key is created — otherwise
  // the operator could lock themselves out of key management.
  // -------------------------------------------------------------------------
  const bearerAuthMiddleware = bearerAuth(db);
  app.use('*', async (c, next) => {
    if (c.req.path.startsWith('/dashboard/')) {
      await next();
      return;
    }
    return bearerAuthMiddleware(c, next);
  });

  // -------------------------------------------------------------------------
  // PAR-33 — per-key throttle (10/min for test keys; live keys bypass).
  // Skipped on `/dashboard/*` for the same reason as bearerAuth above.
  // -------------------------------------------------------------------------
  const throttleMiddleware = testKeyThrottle();
  app.use('*', async (c, next) => {
    if (c.req.path.startsWith('/dashboard/')) {
      await next();
      return;
    }
    return throttleMiddleware(c, next);
  });

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
          // PAR-23: adapter.generate now returns AdapterResult; the
          // healthcheck only cares whether the round-trip succeeded — we
          // discard both the prose and the telemetry meta.
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
  // POST /deliberate (PAR-18 — fire-and-forget)
  //
  // Preset precedence (per Stage 1 elaboration decision):
  //   request.preset > [topology].active in parliament.toml > Debate fallback.
  //
  // Every deliberation — including the default Debate preset — flows through
  // `runTopology()`. The legacy hardcoded five-agent `run()` path is gone;
  // `runTopology(active=debate)` is byte-identical to the pre-refactor Debate
  // pipeline (pinned by the engine's `byte-identical-debate.test.ts`).
  //
  // PAR-18 wire-shape change:
  //   The handler validates the request, mints a UUID, persists a placeholder
  //   row with `status: 'in_flight'`, and returns HTTP 202 with
  //   `{ id, status: 'in_flight' }` immediately — BEFORE the engine has done
  //   any work. The actual `runTopology()` call runs in the background and
  //   appends turns/events to the row as they land via the engine's
  //   `onTurn` / `onEvent` callbacks. The row flips to `completed` (or
  //   `failed` with `error: <message>`) when the engine resolves or throws.
  //
  //   Polling clients reach `GET /deliberate/:id` on a ~2s interval; SSE
  //   clients open `GET /deliberate/:id/stream` and receive each turn as
  //   it lands plus a final `status` event when the run terminates.
  //
  // Old client builds that don't know about `status` continue to work:
  //   - For completed runs they GET the full `DeliberationResult` shape
  //     and ignore the new `status` field.
  //   - For in-flight runs they see a partially-populated result with
  //     `turns: []` initially and growing — the existing UI rehydrate
  //     path (PAR-1) reads through this transparently.
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
      sources: requestSources,
      config: configOverrides,
      transform: transformFlags,
    } = parsed.data;

    // PAR-32 / PRD D2: only `retry_on_upstream_500: true` engages the
    // 5xx-retry decorator. Default `undefined`/`false` leaves adapters
    // unwrapped — callers see upstream errors verbatim. `structured_output`
    // is accepted but unwired in v1.0 (see schema comment).
    const adapterDecorator =
      transformFlags?.retry_on_upstream_500 === true
        ? (adapter: ModelAdapter) => new Retrying5xxAdapter(adapter)
        : undefined;

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

    // Build the topology config eagerly so any structural-config error
    // (missing neurotype block, etc.) surfaces synchronously — that's a
    // 500-class server problem the client should know about before we
    // mint the placeholder row.
    let topologyConfig: TopologyDeliberationConfig;
    try {
      topologyConfig = buildTopologyDeliberationConfig(resolvedTopology, {
        maxRounds: configOverrides?.maxRounds,
        redAgentInterval: configOverrides?.redAgentInterval,
        confidenceThreshold: configOverrides?.confidenceThreshold,
        // PAR-16: forward the user-supplied prose context (when present) so
        // the engine prepends it to every non-Sentry agent's user prompt
        // and echoes it back unchanged on the result.
        ...(requestContext !== undefined ? { context: requestContext } : {}),
        // PAR-17: forward the user-supplied sources (when present) so the
        // engine renders them under `## Sources` for every non-Sentry agent
        // and the Empiricist activates evidence-backed claim mode. Echoed
        // back unchanged on the result.
        ...(requestSources !== undefined && requestSources.length > 0
          ? { sources: requestSources }
          : {}),
        ...(configOverrides?.maxSourceWords !== undefined
          ? { maxSourceWords: configOverrides.maxSourceWords }
          : {}),
        ...(adapterDecorator !== undefined ? { adapterDecorator } : {}),
      });
    } catch (err) {
      return c.json(
        { error: `Failed to build topology config: ${err instanceof Error ? err.message : String(err)}` },
        500,
      );
    }

    const id = crypto.randomUUID();

    // Persist the placeholder row BEFORE returning so a client that
    // immediately polls `GET /deliberate/:id` sees `status: 'in_flight'`
    // and an empty turns array — never a 404 race.
    try {
      createDeliberationRow(db, {
        id,
        topic,
        ...(requestContext !== undefined ? { context: requestContext } : {}),
        // PAR-17: persist sources onto the placeholder row so a client
        // polling mid-run sees the same `sources` array the completed run
        // will eventually carry.
        ...(requestSources !== undefined && requestSources.length > 0
          ? { sources: requestSources }
          : {}),
        preset: resolvedTopology.activePreset.id,
      });
    } catch (err) {
      return c.json(
        { error: `Failed to persist placeholder: ${err instanceof Error ? err.message : String(err)}` },
        500,
      );
    }

    // Wire the engine's turn/event callbacks so each fresh record lands
    // on the persisted row AND fans out to any SSE subscriber. Errors in
    // the persistence path are swallowed — losing one append is far less
    // bad than aborting a 9-minute run mid-flight; the run still
    // completes via `markCompleted` which writes the full snapshot.
    const onTurn = (turn: Turn): void => {
      try {
        appendTurn(db, id, turn);
      } catch (persistErr) {
        console.error(
          `Parliament: failed to persist turn for deliberation ${id}:`,
          persistErr,
        );
      }
      inflightBroker.publish(id, { type: 'turn', turn });
    };
    const onEvent = (event: SystemEvent): void => {
      try {
        appendEvent(db, id, event);
      } catch (persistErr) {
        console.error(
          `Parliament: failed to persist event for deliberation ${id}:`,
          persistErr,
        );
      }
      inflightBroker.publish(id, { type: 'event', event });
    };

    // Kick off the engine in the background. We deliberately do NOT
    // `await` this in the request handler — the whole point of PAR-18 is
    // that long Star Chamber-class runs don't block the POST response.
    // Errors must be caught here (not on the request promise) because
    // the request has already returned by the time the engine resolves.
    const engine = new DeliberationEngine();
    void (async () => {
      try {
        const result = await engine.runTopology(topic, {
          ...topologyConfig,
          onTurn,
          onEvent,
        });
        try {
          markCompleted(db, id, result);
        } catch (persistErr) {
          console.error(
            `Parliament: failed to mark deliberation ${id} completed:`,
            persistErr,
          );
        }
        inflightBroker.publish(id, { type: 'status', status: 'completed' });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // PAR-32 / PRD D2: when the underlying failure was an upstream
        // provider HTTP error, preserve the structured upstream context
        // (provider/status/body/requestId) onto both the persisted row
        // and the terminal SSE event so callers can react to provider
        // failures without parsing the human-readable message.
        const upstream =
          err instanceof UpstreamProviderError ? err.upstream : undefined;
        try {
          markFailed(db, id, message, upstream);
        } catch (persistErr) {
          console.error(
            `Parliament: failed to mark deliberation ${id} failed:`,
            persistErr,
          );
        }
        inflightBroker.publish(id, {
          type: 'status',
          status: 'failed',
          error: message,
          ...(upstream !== undefined ? { upstream } : {}),
        });
      }
    })();

    // 202 Accepted — the standard "your request is being processed" code.
    // The body carries the minimal pair the UI needs to start rehydrating
    // (id) and the lifecycle marker that drives the polling/SSE decision
    // (status). Old client builds that ignore `status` see only the id
    // and continue to GET it as before.
    return c.json({ id, status: 'in_flight' satisfies DeliberationStatus }, 202);
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
  // GET /deliberate/:id (PAR-18 — surfaces partial state during a live run)
  //
  // Returns whatever has been persisted so far: while the engine is running,
  // the response carries `status: 'in_flight'` plus the turns/events that
  // have landed up to this read. When the run reaches a terminal state the
  // response carries `status: 'completed'` (or `'failed'` with an `error`
  // field). Pre-PAR-18 clients that don't read `status` continue to see
  // the same enriched shape as before for completed runs.
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

  // -------------------------------------------------------------------------
  // GET /deliberate/:id/stream (PAR-18 — Server-Sent Events)
  //
  // SSE endpoint that streams turn/event updates as they land plus a final
  // `status` event when the run terminates. On connect we replay whatever
  // turns/events have already been persisted so a late subscriber doesn't
  // miss the round-1 prologue, then subscribe to the in-flight broker for
  // anything that lands afterward.
  //
  // Wire format (SSE):
  //   event: turn          \n data: <Turn JSON>          \n\n
  //   event: system_event  \n data: <SystemEvent JSON>   \n\n
  //   event: status        \n data: {"status": "completed"} \n\n   (terminal)
  //
  // Deliberations that have already terminated by the time we connect:
  //   we replay the persisted turns/events and emit one terminal `status`
  //   event, then close. Clients can rely on always receiving a terminal
  //   `status` event before the stream ends.
  // -------------------------------------------------------------------------
  app.get('/deliberate/:id/stream', (c) => {
    const { id } = c.req.param();

    return streamSSE(c, async (stream) => {
      const initial = getDeliberation(db, id);
      if (initial === null) {
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({ error: `Deliberation "${id}" not found` }),
        });
        return;
      }

      // Track the cursor into the deliberation's turn/event arrays so a
      // race between "publish to broker" and "replay from DB" cannot
      // emit the same record twice. We replay everything currently
      // persisted, then forward only broker events whose turn/event we
      // haven't already emitted.
      let replayedTurns = initial.turns.length;
      let replayedEvents = (initial.events ?? []).length;

      // Replay persisted turns first — clients that connect mid-run
      // need the full transcript so far.
      for (const turn of initial.turns) {
        await stream.writeSSE({
          event: 'turn',
          data: JSON.stringify(turn),
        });
      }
      for (const event of initial.events ?? []) {
        await stream.writeSSE({
          event: 'system_event',
          data: JSON.stringify(event),
        });
      }

      // If the run has already terminated, emit the final status and
      // close. No subscription needed — the broker will have already
      // dropped the topic.
      const initialStatus: DeliberationStatus = initial.status ?? 'completed';
      if (initialStatus !== 'in_flight') {
        const payload: Record<string, unknown> = { status: initialStatus };
        if (initial.error !== undefined) {
          payload['error'] = initial.error;
        }
        // PAR-32 / PRD D2: forward upstream provider context verbatim
        // when the run failed because of an upstream HTTP error.
        if (initial.upstream !== undefined) {
          payload['upstream'] = initial.upstream;
        }
        await stream.writeSSE({
          event: 'status',
          data: JSON.stringify(payload),
        });
        return;
      }

      // Bridge broker pushes onto the SSE stream. We use a simple async
      // queue so the stream's awaited writes can drain naturally without
      // dropping events under back-pressure.
      const pending: InflightEvent[] = [];
      let resumeWaiter: (() => void) | null = null;
      let done = false;
      let terminalEvent: InflightEvent | null = null;

      const handler = (event: InflightEvent): void => {
        // Keep the cursor moving so we don't re-emit a turn the broker
        // sends right after we replayed it from the DB. The broker fires
        // synchronously from the engine's onTurn/onEvent, which means
        // any record visible in `initial.turns` will also surface from
        // the broker exactly once — so we always advance the cursor.
        if (event.type === 'turn') {
          replayedTurns += 1;
        } else if (event.type === 'event') {
          replayedEvents += 1;
        }
        pending.push(event);
        if (event.type === 'status') {
          terminalEvent = event;
        }
        const resume = resumeWaiter;
        if (resume !== null) {
          resumeWaiter = null;
          resume();
        }
      };

      const unsubscribe = inflightBroker.subscribe(id, handler);

      // Re-read the row AFTER subscribing to close the race window:
      // if the deliberation completed between our initial read and
      // subscribe call, the broker won't push a status (it's already
      // dropped the topic). Re-checking the DB catches that case.
      const recheck = getDeliberation(db, id);
      if (recheck !== null && recheck.status !== 'in_flight') {
        // Replay any new turns/events that landed in the gap.
        const newTurns = recheck.turns.slice(replayedTurns);
        for (const turn of newTurns) {
          await stream.writeSSE({ event: 'turn', data: JSON.stringify(turn) });
        }
        const allEvents = recheck.events ?? [];
        const newEvents = allEvents.slice(replayedEvents);
        for (const event of newEvents) {
          await stream.writeSSE({ event: 'system_event', data: JSON.stringify(event) });
        }
        const finalStatus: DeliberationStatus = recheck.status ?? 'completed';
        const payload: Record<string, unknown> = { status: finalStatus };
        if (recheck.error !== undefined) {
          payload['error'] = recheck.error;
        }
        if (recheck.upstream !== undefined) {
          payload['upstream'] = recheck.upstream;
        }
        await stream.writeSSE({ event: 'status', data: JSON.stringify(payload) });
        unsubscribe();
        return;
      }

      // Drain the broker queue until the deliberation reaches a
      // terminal status. The await on `new Promise<void>` is what
      // yields control back to Node so the engine can run.
      try {
        while (!done) {
          if (pending.length === 0) {
            await new Promise<void>((resolve) => {
              resumeWaiter = resolve;
            });
            continue;
          }
          const next = pending.shift()!;
          if (next.type === 'turn') {
            await stream.writeSSE({
              event: 'turn',
              data: JSON.stringify(next.turn),
            });
          } else if (next.type === 'event') {
            await stream.writeSSE({
              event: 'system_event',
              data: JSON.stringify(next.event),
            });
          } else {
            const payload: Record<string, unknown> = { status: next.status };
            if (next.error !== undefined) {
              payload['error'] = next.error;
            }
            if (next.upstream !== undefined) {
              payload['upstream'] = next.upstream;
            }
            await stream.writeSSE({
              event: 'status',
              data: JSON.stringify(payload),
            });
            done = true;
          }
          if (terminalEvent !== null && pending.length === 0) {
            done = true;
          }
        }
      } finally {
        unsubscribe();
      }
    });
  });

  // -------------------------------------------------------------------------
  // PAR-33 / M1 T1.1 — Dashboard key-management endpoints.
  //
  // These live under `/dashboard/api/keys` so they don't collide with the
  // user-facing `/v1/*` namespace. They're guarded by `PARLIAMENT_ADMIN_KEY`
  // (set in env or passed via createRouter options) which is conceptually
  // a separate authentication path from per-account bearer auth — the
  // dashboard speaks to its own admin secret. Real dashboard auth ships
  // with the dashboard surface (M3); for now this admin gate keeps the
  // route safe when exposed outside localhost.
  //
  // Wire shape:
  //   POST /dashboard/api/keys
  //     body: { account_id?: string, key_type: 'test' | 'live', name?: string }
  //     → 201 { id, key_type, prefix, name, created_at, secret }   ← secret ONCE
  //   DELETE /dashboard/api/keys/:id
  //     → 204 on success / first revoke; 404 if not found; 200 if already revoked
  //   GET /dashboard/api/keys?account_id=…
  //     → 200 { keys: [...] } without secrets, includes revoked rows
  // -------------------------------------------------------------------------

  function adminGate(c: Context): Response | undefined {
    if (adminKey === undefined || adminKey === '') {
      return c.json(
        {
          error: {
            code: 'authentication_invalid',
            message:
              'Dashboard endpoints require PARLIAMENT_ADMIN_KEY to be set.',
          },
        },
        403,
      );
    }
    const header = c.req.header('Authorization') ?? '';
    const match = header.match(/^Bearer\s+(.+)$/);
    const presented = match ? match[1].trim() : '';
    // Constant-time compare on equal-length buffers; mismatched lengths
    // skip the compare but still reject.
    const a = Buffer.from(presented);
    const b = Buffer.from(adminKey);
    const ok =
      presented !== '' && a.length === b.length && timingSafeEqual(a, b);
    if (!ok) {
      return c.json(
        {
          error: {
            code: 'authentication_invalid',
            message: 'Invalid PARLIAMENT_ADMIN_KEY.',
          },
        },
        403,
      );
    }
    return undefined;
  }

  const CreateApiKeyBodySchema = z.object({
    account_id: z.string().min(1).optional(),
    key_type: z.enum(['test', 'live']),
    name: z.string().min(1).max(120).optional(),
  });

  app.post('/dashboard/api/keys', async (c) => {
    const denied = adminGate(c);
    if (denied !== undefined) return denied;

    let parsed: z.infer<typeof CreateApiKeyBodySchema>;
    try {
      parsed = CreateApiKeyBodySchema.parse(await c.req.json());
    } catch (err) {
      return c.json(
        {
          error: {
            code: 'invalid_request',
            message: err instanceof Error ? err.message : 'Invalid body',
          },
        },
        400,
      );
    }

    try {
      const issued = await createApiKey(db, {
        accountId: parsed.account_id,
        keyType: parsed.key_type,
        name: parsed.name,
      });
      return c.json(
        {
          id: issued.id,
          account_id: issued.account_id,
          key_type: issued.key_type,
          prefix: issued.prefix,
          name: issued.name,
          created_at: issued.created_at,
          // The secret is returned EXACTLY ONCE here. The persisted row
          // stores only the argon2id hash; subsequent reads will not
          // include `secret`.
          secret: issued.secret,
        },
        201,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = message.startsWith('account not found')
        ? 'invalid_request'
        : 'internal_error';
      const status = code === 'invalid_request' ? 400 : 500;
      return c.json({ error: { code, message } }, status);
    }
  });

  app.get('/dashboard/api/keys', (c) => {
    const denied = adminGate(c);
    if (denied !== undefined) return denied;
    const accountId = c.req.query('account_id') ?? OSS_ACCOUNT_ID;
    return c.json({ keys: listApiKeys(db, accountId) }, 200);
  });

  app.delete('/dashboard/api/keys/:id', (c) => {
    const denied = adminGate(c);
    if (denied !== undefined) return denied;
    const id = c.req.param('id');
    const existing = getApiKey(db, id);
    if (existing === null) {
      return c.json(
        {
          error: {
            code: 'resource_not_found',
            message: `Key ${id} not found.`,
          },
        },
        404,
      );
    }
    const revoked = revokeApiKey(db, id);
    if (!revoked) {
      // Already revoked. Idempotent success — return 200 with the row so
      // the dashboard can re-render without surfacing an error.
      return c.json(
        { id, revoked_at: existing.revoked_at, already_revoked: true },
        200,
      );
    }
    return c.body(null, 204);
  });

  return app;
}
