import type {
  Blackboard,
  DeliberationResult,
  DeliberationSource,
  SplitSummary,
  SystemEvent,
  TerminationReason,
  Turn,
  TurnMeta,
} from './types.js';
import type { Agent, ProviderFailoverInfo } from './agents/base.js';
import type { SynthesizerAgent, SynthesizerResult } from './agents/synthesizer.js';
import type { SentryAgent } from './agents/sentry.js';
import type { TopologyConfig, TopologyStep } from './topology/index.js';
import { executeParallelBlock } from './topology/parallel.js';
import { DEFAULT_MAX_SOURCE_WORDS } from './agents/utils.js';
import type { MemoryProvider, MemoryOutcome } from './memory.js';
import { formatMemoryFragments } from './memory.js';
import type { ContextProvider } from './context.js';
import { formatResolvedContext } from './context.js';

export interface DeliberationConfig {
  /** Maximum number of deliberation rounds. Default: 5. */
  maxRounds: number;
  /** Inject RedAgent every N rounds. Default: 3. */
  redAgentInterval: number;
  /** Synthesizer confidence threshold to declare consensus. Default: 0.7. */
  confidenceThreshold: number;
  /**
   * Optional free-form prose context (PAR-16). When set, the engine writes
   * this onto the blackboard at run start so every non-Sentry agent's
   * `buildPromptHeader` call prepends it under a stable `## Background`
   * heading. Echoed back unchanged on the result so the server response
   * round-trips it.
   *
   * Optional and additive — existing callers that omit it see no behaviour
   * change.
   */
  context?: string;
  /**
   * Optional structured sources (PAR-17). When non-empty, the engine writes
   * them onto the blackboard at run start so every non-Sentry agent's
   * `buildPromptHeader` call renders the same `## Sources` block; the
   * Empiricist additionally flips into evidence-backed mode when any source
   * is present. Echoed back unchanged on the result so the server response
   * round-trips them.
   *
   * Optional and additive — existing callers that omit it see no behaviour
   * change.
   */
  sources?: DeliberationSource[];
  /**
   * Per-source word cap applied at prompt-construction time (PAR-17). Defaults
   * to {@link DEFAULT_MAX_SOURCE_WORDS} (500). The engine truncates each
   * source's `content` to this cap (whitespace-delimited word split) before
   * placing the sources on the blackboard so every agent that reads
   * `blackboard.sources` sees the already-capped content; truncated content
   * carries a trailing `... [truncated]` marker so downstream consumers can
   * detect it.
   */
  maxSourceWords?: number;
  /**
   * PAR-38 — Optional memory provider. When set, the engine calls
   * `recall()` once before round 1 (formatted output is written onto
   * `blackboard.memory` and surfaced in every agent's prompt under a
   * `## Memory` heading) and fires `remember()` after the deliberation
   * terminates. Both calls are wrapped in try/catch — a flaky provider
   * never blocks deliberation.
   */
  memoryProvider?: MemoryProvider;
  /**
   * PAR-38 — Per-account scoping forwarded to the memory provider as the
   * `x-am-agent-id` tenant header. Required when `memoryProvider` is set;
   * ignored otherwise.
   */
  memoryAgentId?: string;
  /** PAR-38 — Max recall fragments. Default 5. */
  memoryRecallLimit?: number;
  /**
   * PAR-39 — Optional ACR context provider. When set, the engine resolves
   * capabilities and budget before round 0 (in parallel with memory recall)
   * and injects the result as a pinned system turn under `## Capabilities &
   * Constraints`. Fail-soft: provider errors log a warning and deliberation
   * proceeds without the context turn.
   */
  contextProvider?: import('./context.js').ContextProvider;
  /**
   * PAR-39 — Budget utilization fraction at which the engine terminates early
   * and sets `incomplete: true` on the outcome. Default 0.8 (80%). Only
   * meaningful when `contextProvider` is set and resolution succeeds.
   */
  contextBudgetCutoff?: number;
  agents: {
    proposer: Agent;
    skeptic: Agent;
    synthesizer: SynthesizerAgent;
    redAgent: Agent;
    sentry: SentryAgent;
  };
}

/**
 * Resolves a step's `neurotype` ID to a concrete `Agent` instance the runtime
 * can call. The runtime is deliberately decoupled from the registry so that
 * user-defined neurotypes (parsed from `[neurotypes.<id>]`) and built-in
 * factories share a single resolution surface.
 *
 * The resolver MUST throw a descriptive `Error` when an ID is unknown — the
 * loader has already validated that every step's neurotype is resolvable, so
 * any throw here is a bug, not user-input handling.
 *
 * PAR-25 — the second `context` argument is additive and optional. The
 * engine passes its own `provider.failover` event-pushing callback here so
 * the resolver can wire it into each agent's `AgentRuntimeOptions`. When
 * the resolver ignores the context (or the agent is not configured for
 * failover), behaviour is unchanged from pre-PAR-25.
 */
export interface NeurotypeResolverContext {
  /**
   * PAR-25 — push a `provider.failover` SystemEvent onto the engine's
   * `events[]` array. Wired into `AgentRuntimeOptions.onProviderFailover`
   * by the resolver when the neurotype's TOML config opts in via
   * `fallback_provider`. The engine deliberately owns the event push (not
   * the resolver) so the event ordering relative to round/synthesis
   * markers stays consistent across all sites that fire failover.
   */
  onProviderFailover: (info: ProviderFailoverInfo) => void;
}

export type NeurotypeResolver = (
  step: TopologyStep,
  context?: NeurotypeResolverContext,
) => Agent;

/** Logger sink the topology runtime uses for non-fatal informational events. */
export interface TopologyRuntimeLogger {
  info(message: string): void;
}

/**
 * Configuration for `DeliberationEngine.runTopology`.
 *
 * The engine wires the resolved `TopologyConfig` (from the loader) plus the
 * three structural-infrastructure agents (Synthesizer, RedAgent, Sentry) that
 * are NOT steppable — Sentry runs out-of-band and Synthesizer/RedAgent are
 * runtime concerns, not preset postures.
 */
export interface TopologyDeliberationConfig {
  /** Maximum number of deliberation rounds. */
  maxRounds: number;
  /** Inject RedAgent every N rounds. Set to a value > maxRounds to disable. */
  redAgentInterval: number;
  /** Synthesizer confidence threshold to declare consensus. */
  confidenceThreshold: number;
  /**
   * The fully-resolved topology configuration from the loader. The engine
   * runs `topology.activePreset.steps` sequentially each round.
   */
  topology: TopologyConfig;
  /**
   * Resolves a step's neurotype ID to a concrete agent instance. The runtime
   * calls this once per step per round so adapters bound to model lifecycles
   * (e.g. lazy-loaded local models) can decide whether to reuse instances.
   */
  resolveNeurotype: NeurotypeResolver;
  /** Synthesizer is structural infrastructure — not steppable. */
  synthesizer: SynthesizerAgent;
  /** RedAgent is structural infrastructure — fires at `redAgentInterval`. */
  redAgent: Agent;
  /**
   * Sentry runs **out-of-band** on every preset — never as a step. The
   * runtime invokes Sentry after each step and after the synthesizer; any
   * `collapse_detected` signal terminates the round with `echo_loop`.
   */
  sentry: SentryAgent;
  /**
   * Optional logger; used to emit one info-level message when a step carries
   * `optional: true` (Stage 1 logs the field but does NOT skip the step —
   * the deferred-evaluation behavior is a Stage 2 concern). Defaults to a
   * no-op when omitted.
   */
  logger?: TopologyRuntimeLogger;
  /**
   * Block-level timeout for `parallel_steps` execution, in milliseconds.
   * Stage 4 — see `add-jury-parallel/specs/topology-parallel/spec.md`. When
   * any sibling exceeds the timeout, the entire deliberation aborts with a
   * `ParallelBlockTimeoutError` naming the slow agent (per the elaboration
   * decision: fail loudly beats silently degrading). When omitted, parallel
   * blocks run without a timeout.
   */
  parallelBlockTimeoutMs?: number;
  /**
   * Optional free-form prose context (PAR-16). When set, the engine writes
   * this onto the blackboard at run start so every non-Sentry agent's
   * `buildPromptHeader` call prepends it under a stable `## Background`
   * heading. Echoed back unchanged on the result so the server response
   * round-trips it.
   *
   * Optional and additive — existing callers that omit it see no behaviour
   * change.
   */
  context?: string;
  /**
   * Optional structured sources (PAR-17). Same semantics as
   * {@link DeliberationConfig.sources} — written onto the blackboard at run
   * start, capped per-source via `maxSourceWords`, echoed back unchanged on
   * the result.
   */
  sources?: DeliberationSource[];
  /**
   * Per-source word cap applied at prompt-construction time (PAR-17). Defaults
   * to {@link DEFAULT_MAX_SOURCE_WORDS} (500).
   */
  maxSourceWords?: number;
  /**
   * PAR-18 — invoked synchronously after the engine appends each fresh `Turn`
   * to the blackboard. The server layer uses this to persist turns
   * progressively (so `GET /deliberate/:id` returns partial state during a
   * long run) and to fan out a server-sent-events stream.
   *
   * Optional and additive: existing callers that omit it observe no
   * behaviour change. Callbacks MUST be fast and non-throwing — the engine
   * does not await them and silently swallows callback errors so a flaky
   * sink (e.g. a closed SSE client) cannot crash a deliberation mid-run.
   */
  onTurn?: (turn: Turn) => void;
  /**
   * PAR-18 — invoked synchronously after the engine emits each
   * `SystemEvent` (round_start, sentry.echo, parallel_block_*,
   * synthesis_attempt, consensus_reached, termination, ...). Same fault
   * tolerance as `onTurn`: errors thrown from the callback are swallowed
   * so a misbehaving sink cannot interrupt the deliberation.
   */
  onEvent?: (event: SystemEvent) => void;
  /**
   * PAR-38 — Optional memory provider. See {@link DeliberationConfig.memoryProvider}.
   */
  memoryProvider?: MemoryProvider;
  /** PAR-38 — Per-account scoping forwarded as the provider's tenant id. */
  memoryAgentId?: string;
  /** PAR-38 — Max recall fragments. Default 5. */
  memoryRecallLimit?: number;
}


/**
 * PAR-17 — normalises a caller-supplied `sources` array for placement on the
 * blackboard.
 *
 *   - Returns `undefined` when the input is undefined / empty so the result
 *     and blackboard echo back a missing field rather than an empty array.
 *   - Truncates each source's `content` to `maxSourceWords` (default 500) at
 *     ingest time using the same whitespace-delimited word split the rest of
 *     the package uses, appending the stable `... [truncated]` marker when
 *     truncation occurred. Doing this once at engine start (rather than on
 *     every prompt build) means `blackboard.sources` is already the
 *     prompt-ready shape every agent and downstream consumer can rely on.
 *   - Preserves the user-supplied `id`, `title`, and `kind` verbatim.
 */
function normalizeSources(
  sources: readonly DeliberationSource[] | undefined,
  maxSourceWords: number,
): DeliberationSource[] | undefined {
  if (sources === undefined || sources.length === 0) return undefined;
  const cap = maxSourceWords > 0 ? maxSourceWords : DEFAULT_MAX_SOURCE_WORDS;
  return sources.map((src) => {
    const trimmed = src.content.trim();
    if (trimmed.length === 0) {
      const result: DeliberationSource = { id: src.id, title: src.title, content: '' };
      if (src.kind !== undefined) result.kind = src.kind;
      return result;
    }
    const words = trimmed.split(/\s+/);
    const content =
      words.length <= cap ? trimmed : `${words.slice(0, cap).join(' ')} ... [truncated]`;
    const result: DeliberationSource = { id: src.id, title: src.title, content };
    if (src.kind !== undefined) result.kind = src.kind;
    return result;
  });
}

/**
 * PAR-38 — Calls `provider.recall()` and writes the formatted result onto
 * `blackboard.memory` so every non-Sentry agent's `buildPromptHeader` call
 * surfaces it under the `## Memory` heading. Failures are logged via
 * `console.warn` and swallowed: a flaky memory backend must never block
 * deliberation. No-op when no provider/agent-id is configured, or when the
 * provider returns zero fragments.
 */
async function attachMemoryRecall(
  blackboard: Blackboard,
  provider: MemoryProvider | undefined,
  agentId: string | undefined,
  limit: number,
): Promise<void> {
  if (provider === undefined || agentId === undefined || agentId.length === 0) {
    return;
  }
  try {
    const fragments = await provider.recall(blackboard.topic, { limit, agentId });
    const formatted = formatMemoryFragments(fragments);
    if (formatted.length > 0) {
      blackboard.memory = formatted;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.warn(`[parliament] memory.recall failed: ${message}`);
  }
}

/**
 * PAR-39 — Resolves ACR capabilities and writes the formatted preamble onto
 * `blackboard.acrContext`. Runs in parallel with `attachMemoryRecall` before
 * round 0. Fail-soft: provider errors are logged and deliberation proceeds
 * without the context turn. Returns the budget token cap (0 = no cap).
 */
async function attachContextResolution(
  blackboard: Blackboard,
  provider: ContextProvider | undefined,
): Promise<number> {
  if (provider === undefined) return 0;
  try {
    const resolved = await provider.resolve(blackboard.topic);
    if (resolved !== null) {
      blackboard.acrContext = formatResolvedContext(resolved);
      return resolved.budget.tokens;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.warn(`[parliament] context.resolve failed: ${message}`);
  }
  return 0;
}

/**
 * PAR-38 — Fire-and-forget call to `provider.remember()` after the
 * deliberation terminates. Returns immediately; the promise is detached so
 * a slow memory write cannot delay the engine resolving its result. Failures
 * surface via `console.warn` from the detached chain.
 */
function dispatchMemoryRemember(
  outcome: MemoryOutcome,
  provider: MemoryProvider | undefined,
  agentId: string | undefined,
): void {
  if (provider === undefined || agentId === undefined || agentId.length === 0) {
    return;
  }
  void provider.remember(outcome, { agentId }).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.warn(`[parliament] memory.remember failed: ${message}`);
  });
}

/**
 * PAR-38 — Builds the `MemoryOutcome` payload for `remember()`. Pulls the
 * distinct agent role labels out of the blackboard turns in first-seen
 * order so the persisted record reflects which neurotypes actually
 * participated (vs. the steady-state preset roster).
 */
function buildMemoryOutcome(
  topic: string,
  terminationReason: TerminationReason,
  synthesis: string | null,
  residueScore: number,
  totalRounds: number,
  turns: Turn[],
): MemoryOutcome {
  const seen = new Set<string>();
  const agents: string[] = [];
  for (const turn of turns) {
    if (!seen.has(turn.agent)) {
      seen.add(turn.agent);
      agents.push(turn.agent);
    }
  }
  return {
    topic,
    terminationReason,
    synthesis,
    residueScore,
    totalRounds,
    agents,
  };
}

/**
 * Computes the residue-of-conflict score for a list of conflicts.
 *
 * Each unresolved conflict is weighted by recency:
 *   weight = 1 + (position_from_end / total_conflicts)
 *
 * residueScore = sum(weights of unresolved) / sum(weights of all conflicts)
 *
 * Returns 0 when there are no conflicts.
 */
function computeResidueScore(conflicts: DeliberationResult['conflicts']): number {
  if (conflicts.length === 0) return 0;

  const total = conflicts.length;
  let weightedAll = 0;
  let weightedUnresolved = 0;

  conflicts.forEach((conflict, index) => {
    const positionFromEnd = total - 1 - index;
    const weight = 1 + positionFromEnd / total;
    weightedAll += weight;
    if (!conflict.resolved) {
      weightedUnresolved += weight;
    }
  });

  return weightedUnresolved / weightedAll;
}

/**
 * PAR-19 — stamps `residue_remaining` onto the most recently appended turn
 * on the blackboard, computed against the current `blackboard.conflicts`
 * snapshot. Used by both engine paths (`run` and `runTopology`) immediately
 * after the synthesizer's turn is recorded so the per-round value is
 * adjacent to the round-summary turn that produced it.
 *
 * Uses the same `computeResidueScore` calculation as the end-of-run
 * `DeliberationResult.residueScore` scalar — the only difference is timing:
 * this fires once per round (right after the synthesizer), whereas the
 * scalar fires once at deliberation termination. The end-of-run scalar's
 * value is therefore guaranteed to equal the final synthesizer turn's
 * `residue_remaining` for any conflicts state that hasn't changed between
 * that synthesizer call and the loop exit.
 *
 * No-op if the blackboard has no turns (defensive — should not happen
 * because the helper is only called after `recordTurn`). Always called
 * with the synthesizer's just-appended turn at the tail; stamps `0` when
 * no conflicts exist (the same value `computeResidueScore` returns).
 */
function stampSynthResidue(blackboard: Blackboard): void {
  const last = blackboard.turns[blackboard.turns.length - 1];
  if (last === undefined) return;
  last.residue_remaining = computeResidueScore(blackboard.conflicts);
}

/**
 * Builds a SplitSummary from the current blackboard when no synthesis was
 * reached. Collects the last turn from each distinct agent role, then marks
 * the split irreconcilable if residueScore > 0.5.
 */
function buildSplitSummary(turns: Turn[], residueScore: number): SplitSummary {
  const positions: Record<string, string> = {};

  // Walk backwards so we capture the last turn per role efficiently.
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i]!;
    if (!(turn.agent in positions)) {
      positions[turn.agent] = turn.content;
    }
  }

  return {
    positions,
    irreconcilable: residueScore > 0.5,
  };
}

/**
 * Counts whitespace-delimited words in `content`. The empty string is zero
 * words; we mirror enforceWordCap's split (`/\s+/` after trim) so the
 * `word_count` field on a Turn is consistent with the cap-counting logic
 * that produced its content.
 */
function countWords(content: string): number {
  const trimmed = content.trim();
  if (trimmed.length === 0) return 0;
  return trimmed.split(/\s+/).length;
}

/**
 * Adds a turn to the blackboard after an agent generates output.
 *
 * Populates the per-turn metadata required by Stage 3 UI work
 * (`agent` → role label, `neurotype` → posture, `model` → model name,
 * `word_count` → whitespace-delimited count). Synthesizer turns also carry
 * structured `meta` (confidence, consensus, agreed[], unresolved[]).
 *
 * PAR-10 enrichment (additive): every freshly recorded turn carries
 * `model_name` (echo of `model`), `neurotype_posture` (the agent's
 * declared posture, falling back to `neurotype` when the agent does not
 * expose one), and `convergence_delta`. Convergence delta is the change
 * between the two prior synthesizer-confidence values — round 1 turns
 * always get 0 because no prior synth exists; later rounds get the signed
 * delta. The server response layer may translate 0 → null for the Stage 3
 * "no movement yet" rendering.
 */
function recordTurn(
  blackboard: Blackboard,
  agent: Agent | SentryAgent | SynthesizerAgent,
  content: string,
  round: number,
  synthConfidenceByRound: ReadonlyMap<number, number>,
  // PAR-23 — accepts the merged TurnMeta shape so adapter telemetry
  // (latency, tokens, cost, provider) lands on every recorded turn alongside
  // the synthesizer's structured fields.
  meta?: TurnMeta,
): void {
  // Posture defaults to the agent's neurotype id when the class does not
  // declare a plain-language posture. Keeps the wire field always populated
  // without forcing every test mock to set it.
  const posture =
    'posture' in agent && typeof agent.posture === 'string'
      ? agent.posture
      : agent.neurotype;

  const turn: Turn = {
    agent: agent.role,
    neurotype: agent.neurotype,
    model: agent.modelName,
    content,
    timestamp: new Date().toISOString(),
    round,
    word_count: countWords(content),
    model_name: agent.modelName,
    neurotype_posture: posture,
    convergence_delta: computeConvergenceDelta(round, synthConfidenceByRound),
  };
  if (meta !== undefined) {
    turn.meta = meta;
  }
  blackboard.turns.push(turn);
}

/**
 * Per-turn convergence delta. Mirrors the server-side computation in
 * `packages/server/src/routes.ts#computeConvergenceDelta`, but with a 0
 * sentinel for the "not measurable" case (round 1, or any round whose prior
 * synth-confidence cannot be located). The server response layer translates
 * 0 → null for round-1 turns when the Stage 3 UI needs the explicit
 * "no movement yet" rendering.
 *
 * Definition: how the synthesizer's confidence shifted going INTO this round.
 *   delta(R) = synth_confidence(R-1) - synth_confidence(R-2)
 *
 * R = 1 → 0 (no prior synth to compare).
 * R = 2 → synth(R-1) - 0 = synth(R-1).
 * R > 2 → synth(R-1) - synth(R-2).
 *
 * Returns 0 if `synth(R-1)` is not present (e.g. early termination via
 * Sentry collapse before the synthesizer ran). The 4-decimal rounding
 * matches the server-side formatting so a turn travelling through
 * `enrichResult` keeps the same numeric value.
 */
function computeConvergenceDelta(
  round: number,
  synthByRound: ReadonlyMap<number, number>,
): number {
  if (round <= 1) return 0;
  const prior = synthByRound.get(round - 1);
  if (prior === undefined) return 0;
  const before = synthByRound.get(round - 2) ?? 0;
  return Number((prior - before).toFixed(4));
}

/**
 * First-class consensus signal: the engine terminates only when the
 * synthesizer (a) explicitly votes `consensus: true` AND (b) reports
 * confidence at or above the configured threshold. We deliberately do NOT
 * terminate on confidence alone — that's how the old regex-on-prose path
 * silently bypassed the human signal.
 */
function shouldTerminateOnConsensus(
  result: SynthesizerResult,
  threshold: number,
): boolean {
  // Defensive: if `meta` is somehow missing (shouldn't happen post-rewrite),
  // never terminate. We do NOT fall back to regex parsing of prose.
  if (result.meta === undefined) return false;
  return result.meta.consensus === true && result.meta.confidence >= threshold;
}

export class DeliberationEngine {
  /**
   * Runs a structured multi-agent deliberation on the given topic.
   *
   * The loop proceeds as follows per round:
   *   1. Proposer generates (round 1 only; subsequent rounds use Synthesizer
   *      output as context via the blackboard).
   *   2. Skeptic generates and appends a Conflict to the blackboard.
   *   3. Sentry checks — collapse_detected terminates with echo_loop.
   *   4. Synthesizer generates — terminates with consensus when the
   *      synthesizer's `meta.consensus` is true AND `meta.confidence` >= threshold.
   *   5. Sentry checks again after Synthesizer.
   *   6. If round % redAgentInterval === 0: RedAgent generates.
   *   After maxRounds with no earlier termination: terminates with max_rounds.
   */
  async run(topic: string, config: DeliberationConfig): Promise<DeliberationResult> {
    const {
      maxRounds,
      redAgentInterval,
      confidenceThreshold,
    } = config;

    // Read agent references without mutating config.
    const { proposer, skeptic, synthesizer, redAgent, sentry } = config.agents;

    const startedAt = new Date().toISOString();

    // PAR-16: Normalise context to a trimmed string (or undefined). Empty /
    // whitespace-only input is treated as absent so the result echoes back a
    // missing field rather than a blank string and the prompt builder skips
    // the heading entirely.
    const trimmedContext = config.context?.trim();
    const normalizedContext =
      trimmedContext !== undefined && trimmedContext.length > 0
        ? trimmedContext
        : undefined;

    // PAR-17: normalise sources once at engine start so `blackboard.sources`
    // carries the prompt-ready shape every agent's `buildPromptHeader` call
    // can render directly without re-running the per-source word-cap.
    const normalizedSources = normalizeSources(
      config.sources,
      config.maxSourceWords ?? DEFAULT_MAX_SOURCE_WORDS,
    );

    const blackboard: Blackboard = {
      topic,
      turns: [],
      conflicts: [],
      metadata: {},
      ...(normalizedContext !== undefined ? { context: normalizedContext } : {}),
      ...(normalizedSources !== undefined ? { sources: normalizedSources } : {}),
    };

    // PAR-38 + PAR-39: run memory recall and ACR context resolution in parallel
    // before round 1. Both are fail-soft — a flaky provider never blocks deliberation.
    const [, acrBudgetTokens] = await Promise.all([
      attachMemoryRecall(
        blackboard,
        config.memoryProvider,
        config.memoryAgentId,
        config.memoryRecallLimit ?? 5,
      ),
      attachContextResolution(blackboard, config.contextProvider),
    ]);
    const acrBudgetCutoff = config.contextBudgetCutoff ?? 0.8;
    // Token threshold at which the engine will terminate early (0 = no limit).
    const acrTokenThreshold = acrBudgetTokens > 0
      ? Math.floor(acrBudgetTokens * acrBudgetCutoff)
      : 0;

    let terminationReason: TerminationReason = 'max_rounds';
    let synthesis: string | null = null;
    let totalRounds = 0;
    let budgetCutoffHit = false;
    const events: SystemEvent[] = [];
    // Tracks each round's synthesizer confidence so `recordTurn` can attach
    // a stable `convergence_delta` to every fresh turn without re-walking
    // the transcript.
    const synthConfidenceByRound = new Map<number, number>();
    // Best-effort fallback: when the loop exits without crossing the
    // consensus threshold, surface the highest-confidence synth attempt
    // rather than null so callers see the model's reasoning.
    let bestSynthAttempt: { content: string; confidence: number } | null = null;

    for (let round = 1; round <= maxRounds; round++) {
      totalRounds = round;

      // PAR-10: round_start lifecycle marker. Emitted before any agent runs
      // so the Observability panel can render a round divider even when the
      // round terminates early via Sentry collapse.
      events.push({
        round,
        kind: 'round_start',
        message: `Round ${round} started.`,
        timestamp: new Date().toISOString(),
      });

      // ------------------------------------------------------------------ //
      // Step 1: Proposer (round 1 only)
      // ------------------------------------------------------------------ //
      if (round === 1) {
        const proposerResult = await proposer.generate(blackboard);
        recordTurn(
          blackboard,
          proposer,
          proposerResult.content,
          round,
          synthConfidenceByRound,
          proposerResult.meta,
        );
      }

      // ------------------------------------------------------------------ //
      // Step 2: Skeptic — always generates; appends Conflict to blackboard.
      // (SkepticAgent already mutates blackboard.conflicts internally, but we
      //  call generate to drive that side-effect and record the turn.)
      // ------------------------------------------------------------------ //
      const skepticResult = await skeptic.generate(blackboard);
      recordTurn(
        blackboard,
        skeptic,
        skepticResult.content,
        round,
        synthConfidenceByRound,
        skepticResult.meta,
      );

      // ------------------------------------------------------------------ //
      // Step 3: Sentry check — terminate on collapse_detected
      // ------------------------------------------------------------------ //
      const sentryResult1 = await sentry.generate(blackboard);
      if (sentryResult1.signal === 'collapse_detected') {
        events.push({
          round,
          kind: 'sentry.echo',
          message: 'Sentry detected echo collapse after critic phase; deliberation terminated.',
          timestamp: new Date().toISOString(),
        });
        terminationReason = 'echo_loop';
        break;
      }

      // ------------------------------------------------------------------ //
      // Step 4: Synthesizer — terminate when the synthesizer explicitly votes
      // consensus AND its calibrated confidence clears the threshold.
      // ------------------------------------------------------------------ //
      const synthResult = await synthesizer.generate(blackboard);
      recordTurn(
        blackboard,
        synthesizer,
        synthResult.content,
        round,
        synthConfidenceByRound,
        synthResult.meta,
      );
      // PAR-19: stamp the per-round residue onto the synthesizer turn we
      // just appended. Uses the same `computeResidueScore` calculation as
      // the end-of-run `residueScore` scalar — evaluated against the
      // conflicts state at the moment the synthesizer fires for this round.
      // The Stage 3 Observability panel groups turns by round and reads
      // this field for its "Disagreement remaining" per-round bar chart.
      stampSynthResidue(blackboard);
      // Record the confidence the synthesizer just produced so subsequent
      // turns (and the next round) see it via `convergence_delta`.
      if (synthResult.meta !== undefined) {
        synthConfidenceByRound.set(round, synthResult.meta.confidence);
        const conf = synthResult.meta.confidence;
        if (bestSynthAttempt === null || conf > bestSynthAttempt.confidence) {
          bestSynthAttempt = { content: synthResult.content, confidence: conf };
        }
      }
      events.push({
        round,
        kind: 'synthesis_attempt',
        message: `Synthesizer attempted reconciliation in round ${round}.`,
        timestamp: new Date().toISOString(),
        data:
          synthResult.meta !== undefined
            ? {
                confidence: synthResult.meta.confidence,
                consensus: synthResult.meta.consensus,
              }
            : undefined,
      });

      if (shouldTerminateOnConsensus(synthResult, confidenceThreshold)) {
        synthesis = synthResult.content;
        terminationReason = 'consensus';
        events.push({
          round,
          kind: 'consensus_reached',
          message: `Consensus reached in round ${round}.`,
          timestamp: new Date().toISOString(),
          data: synthResult.meta !== undefined
            ? { confidence: synthResult.meta.confidence }
            : undefined,
        });
        events.push({
          round,
          kind: 'round_end',
          message: `Round ${round} ended (consensus).`,
          timestamp: new Date().toISOString(),
        });
        break;
      }

      // ------------------------------------------------------------------ //
      // Step 5: Sentry check again after Synthesizer
      // ------------------------------------------------------------------ //
      const sentryResult2 = await sentry.generate(blackboard);
      if (sentryResult2.signal === 'collapse_detected') {
        events.push({
          round,
          kind: 'sentry.echo',
          message: 'Sentry detected echo collapse after synthesizer; deliberation terminated.',
          timestamp: new Date().toISOString(),
        });
        terminationReason = 'echo_loop';
        break;
      }

      // ------------------------------------------------------------------ //
      // Step 6: RedAgent injection at interval
      // ------------------------------------------------------------------ //
      if (round % redAgentInterval === 0) {
        const redResult = await redAgent.generate(blackboard);
        recordTurn(
          blackboard,
          redAgent,
          redResult.content,
          round,
          synthConfidenceByRound,
          redResult.meta,
        );
        events.push({
          round,
          kind: 'red_agent.injection',
          message: redResult.content,
          timestamp: new Date().toISOString(),
        });
      }

      // PAR-10: round_end lifecycle marker. Emitted only when the round
      // completes its full step sequence — if Sentry collapse or consensus
      // terminates the round early, we already emitted the appropriate
      // event above and broke out of the loop.
      events.push({
        round,
        kind: 'round_end',
        message: `Round ${round} ended.`,
        timestamp: new Date().toISOString(),
      });

      // PAR-39: budget cutoff — if ACR reported a token budget and cumulative
      // usage exceeds the cutoff threshold, terminate early with incomplete: true.
      if (acrTokenThreshold > 0) {
        const usedTokens = blackboard.turns.reduce((sum, t) => {
          const meta = t.meta;
          return sum + ((meta?.promptTokens ?? 0) + (meta?.completionTokens ?? 0));
        }, 0);
        if (usedTokens >= acrTokenThreshold) {
          terminationReason = 'max_rounds';
          budgetCutoffHit = true;
          events.push({
            round,
            kind: 'termination',
            message: `ACR budget cutoff hit after round ${round} (${usedTokens} tokens ≥ ${acrTokenThreshold} threshold).`,
            timestamp: new Date().toISOString(),
            data: { reason: 'budget_cutoff', usedTokens, acrTokenThreshold },
          });
          break;
        }
      }
    }

    // -------------------------------------------------------------------- //
    // Compute final outcome
    // -------------------------------------------------------------------- //
    const residueScore = computeResidueScore(blackboard.conflicts);
    const resolved = blackboard.conflicts.length === 0 ||
      blackboard.conflicts.every((c) => c.resolved);

    // `split` reflects termination state — populated whenever the engine
    // didn't reach consensus, regardless of whether we surface a best-effort
    // synthesis below. The split positions are the canonical "no agreement"
    // structured output; synthesis is the best-effort prose.
    const split: SplitSummary | null =
      terminationReason === 'consensus'
        ? null
        : buildSplitSummary(blackboard.turns, residueScore);

    // Surface the model's best synthesis even when consensus didn't trigger.
    // Without this, max_rounds / echo_loop terminations return synthesis=null
    // even though the synthesizer produced coherent reasoning every round —
    // hiding the most informative output from the caller.
    if (synthesis === null && bestSynthAttempt !== null) {
      synthesis = bestSynthAttempt.content;
    }

    // PAR-10: termination lifecycle marker. Always emitted, regardless of
    // why the loop exited, so the Observability panel can render a final
    // "ended at round N — reason" entry without inspecting the result
    // fields.
    events.push({
      round: totalRounds,
      kind: 'termination',
      message: `Deliberation terminated after round ${totalRounds} (${terminationReason}).`,
      timestamp: new Date().toISOString(),
      data: { reason: terminationReason, totalRounds },
    });

    const completedAt = new Date().toISOString();

    // PAR-38: persist the deliberation outcome via the memory provider.
    // Fire-and-forget so a slow `remember()` never delays the resolved
    // promise; failures surface via console.warn from the detached chain.
    dispatchMemoryRemember(
      buildMemoryOutcome(
        topic,
        terminationReason,
        synthesis,
        residueScore,
        totalRounds,
        blackboard.turns,
      ),
      config.memoryProvider,
      config.memoryAgentId,
    );

    return {
      topic,
      ...(normalizedContext !== undefined ? { context: normalizedContext } : {}),
      ...(normalizedSources !== undefined ? { sources: normalizedSources } : {}),
      ...(blackboard.memory !== undefined ? { memory: blackboard.memory } : {}),
      turns: blackboard.turns,
      conflicts: blackboard.conflicts,
      residueScore,
      resolved,
      synthesis,
      split,
      terminationReason,
      totalRounds,
      started_at: startedAt,
      completed_at: completedAt,
      events,
      // PAR-18 — direct callers of the legacy run() pipeline see a coherent
      // terminal status (only the topology runtime is wired to the server's
      // background runner; this stays additive for the byte-identical
      // regression test, which only inspects `turns`).
      status: 'completed',
      // PAR-39 — set only when the ACR budget cutoff terminated the run early.
      ...(budgetCutoffHit ? { incomplete: true as const } : {}),
    };
  }

  /**
   * Topology-driven deliberation. Replaces the hardcoded five-agent pipeline
   * (`run` above) with a generic step-sequencer that consumes a resolved
   * `TopologyConfig` from the loader.
   *
   * Per-round execution order:
   *   1. Walk `topology.activePreset.steps` in declared order. For each step:
   *        a. Resolve the step's neurotype ID via `resolveNeurotype(step)`.
   *        b. Call `agent.generate(blackboard)` and record the turn.
   *        c. Out-of-band Sentry check — any `collapse_detected` signal
   *           terminates with `echo_loop` immediately. Sentry is NEVER a
   *           step; the loader rejects any preset that lists it in `steps`.
   *   2. Synthesizer (structural infrastructure, not a step). Records its
   *      turn with `meta`. Terminates with `consensus` when
   *      `meta.consensus === true && meta.confidence >= confidenceThreshold`.
   *   3. Out-of-band Sentry check again after the synthesizer.
   *   4. RedAgent injection when `round % redAgentInterval === 0` (also
   *      structural infrastructure — fires after the synthesizer to disrupt
   *      premature consensus mid-debate).
   *   After `maxRounds` with no earlier termination: `max_rounds`.
   *
   * The `optional: true` field on a step is parsed (the loader accepts and
   * defaults it) and logged but NOT acted on in Stage 1 — skip semantics
   * are deferred per the elaboration decision so this stage can ship before
   * the runtime has a way to evaluate skip predicates.
   */
  async runTopology(
    topic: string,
    config: TopologyDeliberationConfig,
  ): Promise<DeliberationResult> {
    const {
      maxRounds,
      redAgentInterval,
      confidenceThreshold,
      topology,
      resolveNeurotype,
      synthesizer,
      redAgent,
      sentry,
    } = config;

    const logger: TopologyRuntimeLogger = config.logger ?? { info: () => {} };

    const startedAt = new Date().toISOString();

    // PAR-16: see `run()` above — same normalization rule.
    const trimmedContext = config.context?.trim();
    const normalizedContext =
      trimmedContext !== undefined && trimmedContext.length > 0
        ? trimmedContext
        : undefined;

    // PAR-17: see `run()` above — normalise sources once at engine start.
    const normalizedSources = normalizeSources(
      config.sources,
      config.maxSourceWords ?? DEFAULT_MAX_SOURCE_WORDS,
    );

    const blackboard: Blackboard = {
      topic,
      turns: [],
      conflicts: [],
      metadata: {
        active_preset: topology.activePreset.id,
      },
      ...(normalizedContext !== undefined ? { context: normalizedContext } : {}),
      ...(normalizedSources !== undefined ? { sources: normalizedSources } : {}),
    };

    // PAR-38: same recall flow as `run()` — fail-soft, no-op when no
    // provider is configured. Must run BEFORE round 1 so the first
    // step's prompt header surfaces the `## Memory` block.
    await attachMemoryRecall(
      blackboard,
      config.memoryProvider,
      config.memoryAgentId,
      config.memoryRecallLimit ?? 5,
    );

    let terminationReason: TerminationReason = 'max_rounds';
    let synthesis: string | null = null;
    let totalRounds = 0;
    const events: SystemEvent[] = [];
    // Tracks each round's synthesizer confidence so `recordTurn` can attach
    // a stable `convergence_delta` to every fresh turn without re-walking
    // the transcript. Mirrors the `run()` method.
    const synthConfidenceByRound = new Map<number, number>();
    // Best-effort fallback for non-consensus terminations — see `run()`.
    let bestSynthAttempt: { content: string; confidence: number } | null = null;
    // PAR-25 — tracks the round in which each step is currently executing
    // so the failover event-push helper can stamp the right round number
    // without re-threading it through every resolver call. Updated at the
    // top of each round-loop iteration.
    let currentRound = 0;

    // PAR-18 — fan out turns and events to caller-supplied sinks as they
    // happen. We swallow errors so a misbehaving sink (e.g. a disconnected
    // SSE client) cannot interrupt the deliberation. The wrappers fire only
    // when the caller wires a callback; the empty-callback path is a tight
    // loop with no per-turn overhead.
    const onTurn = config.onTurn;
    const onEvent = config.onEvent;
    const notifyLastTurn = (): void => {
      if (onTurn === undefined) return;
      const last = blackboard.turns[blackboard.turns.length - 1];
      if (last === undefined) return;
      try {
        onTurn(last);
      } catch {
        // intentionally silent — see PAR-18 callback contract on
        // `TopologyDeliberationConfig.onTurn`.
      }
    };
    const notifyTurn = (turn: Turn): void => {
      if (onTurn === undefined) return;
      try {
        onTurn(turn);
      } catch {
        // intentionally silent — see PAR-18 callback contract.
      }
    };
    const pushEvent = (event: SystemEvent): void => {
      events.push(event);
      if (onEvent === undefined) return;
      try {
        onEvent(event);
      } catch {
        // intentionally silent — see PAR-18 callback contract on
        // `TopologyDeliberationConfig.onEvent`.
      }
    };

    // PAR-25 — every agent the resolver constructs receives this callback as
    // its `AgentRuntimeOptions.onProviderFailover`. When the agent retries on
    // the configured fallback adapter, it fires the callback once; we push a
    // `provider.failover` SystemEvent through the standard `pushEvent`
    // pipeline so SSE subscribers and the persisted `events[]` array see the
    // failover in the same chronological order as round/synth markers. The
    // round is taken from `currentRound` (updated at each round-loop entry)
    // so the event lands on the round in which the underlying adapter call
    // actually fired, not the round when the engine started.
    const handleProviderFailover = (info: ProviderFailoverInfo): void => {
      pushEvent({
        round: currentRound,
        kind: 'provider.failover',
        message:
          `${info.neurotype} failover: ${info.primary} → ${info.fallback} (${info.error})`,
        timestamp: new Date().toISOString(),
        data: {
          neurotype: info.neurotype,
          primary: info.primary,
          fallback: info.fallback,
          error: info.error,
        },
      });
    };
    const resolverContext: NeurotypeResolverContext = {
      onProviderFailover: handleProviderFailover,
    };

    // Log every optional-flagged step exactly once at engine start so the
    // information surfaces even when we terminate before that step runs.
    for (const step of topology.activePreset.steps) {
      if (step.optional) {
        logger.info(
          `topology: step "${step.id}" (neurotype "${step.neurotype}") declared optional=true; ` +
          `Stage 1 runs it anyway (skip semantics are deferred)`,
        );
      }
    }

    roundLoop: for (let round = 1; round <= maxRounds; round++) {
      totalRounds = round;
      // PAR-25: keep `currentRound` aligned with the round-loop counter so
      // the failover-event helper stamps the correct round on any
      // `provider.failover` event the agents fire during this iteration.
      currentRound = round;

      // PAR-10: round_start lifecycle marker. Emitted before any agent runs
      // so the Observability panel can render a round divider even when the
      // round terminates early via Sentry collapse.
      pushEvent({
        round,
        kind: 'round_start',
        message: `Round ${round} started.`,
        timestamp: new Date().toISOString(),
      });

      // ------------------------------------------------------------------ //
      // Step phase: walk the preset's declared step list in order.
      // ------------------------------------------------------------------ //
      for (const step of topology.activePreset.steps) {
        // Round-1-only Proposer: the Proposer opens the deliberation; on
        // subsequent rounds the synthesizer's reconciliation carries the
        // thread forward via the blackboard. This matches the legacy
        // pipeline's behavior and is what the byte-identical Debate
        // regression test pins.
        if (round > 1 && step.neurotype === 'proposer') continue;

        // PAR-25: pass the resolver context so the resolver can wire the
        // engine's `provider.failover` push fn into each agent's
        // `AgentRuntimeOptions.onProviderFailover`. Resolvers from older
        // call sites that ignore the second arg keep working.
        const agent = resolveNeurotype(step, resolverContext);
        const result = await agent.generate(blackboard);
        recordTurn(
          blackboard,
          agent,
          result.content,
          round,
          synthConfidenceByRound,
          result.meta,
        );
        notifyLastTurn();

        // Out-of-band Sentry after every step. The loader has already
        // forbidden Sentry from appearing in steps, so this is the ONLY
        // place Sentry runs during the step phase.
        const sentryStepResult = await sentry.generate(blackboard);
        if (sentryStepResult.signal === 'collapse_detected') {
          pushEvent({
            round,
            kind: 'sentry.echo',
            message: `Sentry detected echo collapse after step "${step.id}"; deliberation terminated.`,
            timestamp: new Date().toISOString(),
          });
          terminationReason = 'echo_loop';
          break roundLoop;
        }
      }

      // ------------------------------------------------------------------ //
      // Parallel-step phase: when a preset declares `parallel_steps`, every
      // sibling runs against the SAME read-only snapshot of the blackboard
      // taken at block start. Results merge back into the live blackboard
      // in registration order, NOT completion order. A single block-level
      // timeout aborts the whole deliberation if any sibling stalls.
      // Stage 4 — see add-jury-parallel/specs/topology-parallel/spec.md.
      // ------------------------------------------------------------------ //
      const parallelSteps = topology.activePreset.parallel_steps;
      if (parallelSteps !== undefined && parallelSteps.length > 0) {
        const parallelOpts: {
          timeoutMs?: number;
          logger?: TopologyRuntimeLogger;
          synthConfidenceByRound?: ReadonlyMap<number, number>;
          resolverContext?: NeurotypeResolverContext;
        } = {
          logger,
          synthConfidenceByRound,
          // PAR-25: thread the resolver context through to the parallel
          // executor so siblings constructed inside the block share the
          // same failover wiring as sequential steps.
          resolverContext,
        };
        if (config.parallelBlockTimeoutMs !== undefined) {
          parallelOpts.timeoutMs = config.parallelBlockTimeoutMs;
        }
        const parallelResult = await executeParallelBlock(
          parallelSteps,
          blackboard,
          resolveNeurotype,
          round,
          parallelOpts,
        );

        // PAR-10: parallel_block_start marker. We emit AFTER the executor
        // returns so the event payload can carry the actual `parallel_group`
        // UUID minted by the executor — UI consumers correlate on this id.
        pushEvent({
          round,
          kind: 'parallel_block_start',
          message: `Parallel block started in round ${round} with ${parallelSteps.length} sibling(s).`,
          timestamp: new Date().toISOString(),
          data: {
            parallel_group: parallelResult.parallelGroup,
            siblingCount: parallelSteps.length,
          },
        });

        // Append turns + new conflicts in registration order. We push
        // straight onto the live blackboard rather than calling
        // `recordTurn` because the parallel executor already produced
        // fully-formed `Turn` records (with `parallel_group` set).
        blackboard.turns.push(...parallelResult.turns);
        blackboard.conflicts.push(...parallelResult.conflicts);
        // PAR-18: fan out each merged sibling turn to the caller's onTurn
        // sink. The executor produced fully-formed records but the engine
        // is the single point where they become observable to subscribers
        // — emit in registration order to mirror the visible blackboard.
        for (const siblingTurn of parallelResult.turns) {
          notifyTurn(siblingTurn);
        }

        pushEvent({
          round,
          kind: 'parallel_block_end',
          message: `Parallel block ended in round ${round}.`,
          timestamp: new Date().toISOString(),
          data: {
            parallel_group: parallelResult.parallelGroup,
            turnCount: parallelResult.turns.length,
            conflictCount: parallelResult.conflicts.length,
          },
        });

        // Out-of-band Sentry once after the parallel block. We check ONCE
        // after the merge, not per-sibling, because the block is a single
        // logical step in the preset's contract.
        const sentryParallelResult = await sentry.generate(blackboard);
        if (sentryParallelResult.signal === 'collapse_detected') {
          pushEvent({
            round,
            kind: 'sentry.echo',
            message: 'Sentry detected echo collapse after parallel block; deliberation terminated.',
            timestamp: new Date().toISOString(),
          });
          terminationReason = 'echo_loop';
          break roundLoop;
        }
      }

      // ------------------------------------------------------------------ //
      // Synthesizer (structural infrastructure — not a step).
      // ------------------------------------------------------------------ //
      const synthResult = await synthesizer.generate(blackboard);
      recordTurn(
        blackboard,
        synthesizer,
        synthResult.content,
        round,
        synthConfidenceByRound,
        synthResult.meta,
      );
      // PAR-19: stamp the per-round residue onto the synthesizer turn we
      // just appended. Mirrors the legacy `run()` path. The stamp must
      // happen BEFORE `notifyLastTurn()` so the PAR-18 progressive-turn
      // sink and the persisted blackboard turn agree on the field's value.
      stampSynthResidue(blackboard);
      notifyLastTurn();
      // Record the confidence the synthesizer just produced so subsequent
      // turns (and the next round) see it via `convergence_delta`.
      if (synthResult.meta !== undefined) {
        synthConfidenceByRound.set(round, synthResult.meta.confidence);
        const conf = synthResult.meta.confidence;
        if (bestSynthAttempt === null || conf > bestSynthAttempt.confidence) {
          bestSynthAttempt = { content: synthResult.content, confidence: conf };
        }
      }
      pushEvent({
        round,
        kind: 'synthesis_attempt',
        message: `Synthesizer attempted reconciliation in round ${round}.`,
        timestamp: new Date().toISOString(),
        data:
          synthResult.meta !== undefined
            ? {
                confidence: synthResult.meta.confidence,
                consensus: synthResult.meta.consensus,
              }
            : undefined,
      });

      if (shouldTerminateOnConsensus(synthResult, confidenceThreshold)) {
        synthesis = synthResult.content;
        terminationReason = 'consensus';
        pushEvent({
          round,
          kind: 'consensus_reached',
          message: `Consensus reached in round ${round}.`,
          timestamp: new Date().toISOString(),
          data: synthResult.meta !== undefined
            ? { confidence: synthResult.meta.confidence }
            : undefined,
        });
        pushEvent({
          round,
          kind: 'round_end',
          message: `Round ${round} ended (consensus).`,
          timestamp: new Date().toISOString(),
        });
        break;
      }

      // Out-of-band Sentry after synthesizer.
      const sentryPostSynthResult = await sentry.generate(blackboard);
      if (sentryPostSynthResult.signal === 'collapse_detected') {
        pushEvent({
          round,
          kind: 'sentry.echo',
          message: 'Sentry detected echo collapse after synthesizer; deliberation terminated.',
          timestamp: new Date().toISOString(),
        });
        terminationReason = 'echo_loop';
        break;
      }

      // ------------------------------------------------------------------ //
      // RedAgent injection at interval (structural infrastructure).
      // ------------------------------------------------------------------ //
      if (round % redAgentInterval === 0) {
        const redResult = await redAgent.generate(blackboard);
        recordTurn(
          blackboard,
          redAgent,
          redResult.content,
          round,
          synthConfidenceByRound,
          redResult.meta,
        );
        notifyLastTurn();
        pushEvent({
          round,
          kind: 'red_agent.injection',
          message: redResult.content,
          timestamp: new Date().toISOString(),
        });
      }

      // PAR-10: round_end lifecycle marker for a complete round iteration.
      pushEvent({
        round,
        kind: 'round_end',
        message: `Round ${round} ended.`,
        timestamp: new Date().toISOString(),
      });
    }

    const residueScore = computeResidueScore(blackboard.conflicts);
    const resolved = blackboard.conflicts.length === 0 ||
      blackboard.conflicts.every((c) => c.resolved);

    // Mirrors the `run()` method — split tracks termination state, not
    // synthesis presence; synthesis falls back to best-effort prose.
    const split: SplitSummary | null =
      terminationReason === 'consensus'
        ? null
        : buildSplitSummary(blackboard.turns, residueScore);
    if (synthesis === null && bestSynthAttempt !== null) {
      synthesis = bestSynthAttempt.content;
    }

    // PAR-10: termination lifecycle marker. Always emitted, regardless of
    // why the loop exited.
    pushEvent({
      round: totalRounds,
      kind: 'termination',
      message: `Deliberation terminated after round ${totalRounds} (${terminationReason}).`,
      timestamp: new Date().toISOString(),
      data: { reason: terminationReason, totalRounds },
    });

    const completedAt = new Date().toISOString();

    // PAR-38: persist the deliberation outcome via the memory provider.
    // Fire-and-forget — see `run()` for rationale.
    dispatchMemoryRemember(
      buildMemoryOutcome(
        topic,
        terminationReason,
        synthesis,
        residueScore,
        totalRounds,
        blackboard.turns,
      ),
      config.memoryProvider,
      config.memoryAgentId,
    );

    return {
      topic,
      // PAR-20: stamp the preset id that produced this deliberation so the
      // UI can render a per-preset color/badge in the list, the result-view
      // header, and the picker without re-deriving from turn shape. Always
      // populated by runTopology() (every preset has an id); the legacy
      // hardcoded `run()` pipeline above leaves it absent — that path is
      // only reached from the byte-identical-debate regression test, which
      // intentionally pins the pre-topology contract.
      preset: topology.activePreset.id,
      ...(normalizedContext !== undefined ? { context: normalizedContext } : {}),
      ...(normalizedSources !== undefined ? { sources: normalizedSources } : {}),
      ...(blackboard.memory !== undefined ? { memory: blackboard.memory } : {}),
      turns: blackboard.turns,
      conflicts: blackboard.conflicts,
      residueScore,
      resolved,
      synthesis,
      split,
      terminationReason,
      totalRounds,
      started_at: startedAt,
      completed_at: completedAt,
      events,
      // PAR-18 — direct callers (tests, CLI) reading `runTopology()`'s
      // resolved value see a coherent terminal status. The server's
      // background runner ignores this and writes its own status onto the
      // persisted row when the engine resolves vs. throws.
      status: 'completed',
    };
  }
}
