import type {
  Blackboard,
  DeliberationResult,
  SplitSummary,
  SynthesizerMeta,
  SystemEvent,
  TerminationReason,
  Turn,
} from './types.js';
import type { Agent } from './agents/base.js';
import type { SynthesizerAgent, SynthesizerResult } from './agents/synthesizer.js';
import type { SentryAgent } from './agents/sentry.js';
import type { TopologyConfig, TopologyStep } from './topology/index.js';
import { executeParallelBlock } from './topology/parallel.js';

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
 */
export type NeurotypeResolver = (step: TopologyStep) => Agent;

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
  meta?: SynthesizerMeta,
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

    const blackboard: Blackboard = {
      topic,
      turns: [],
      conflicts: [],
      metadata: {},
      ...(normalizedContext !== undefined ? { context: normalizedContext } : {}),
    };

    let terminationReason: TerminationReason = 'max_rounds';
    let synthesis: string | null = null;
    let totalRounds = 0;
    const events: SystemEvent[] = [];
    // Tracks each round's synthesizer confidence so `recordTurn` can attach
    // a stable `convergence_delta` to every fresh turn without re-walking
    // the transcript.
    const synthConfidenceByRound = new Map<number, number>();

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
        recordTurn(blackboard, proposer, proposerResult.content, round, synthConfidenceByRound);
      }

      // ------------------------------------------------------------------ //
      // Step 2: Skeptic — always generates; appends Conflict to blackboard.
      // (SkepticAgent already mutates blackboard.conflicts internally, but we
      //  call generate to drive that side-effect and record the turn.)
      // ------------------------------------------------------------------ //
      const skepticResult = await skeptic.generate(blackboard);
      recordTurn(blackboard, skeptic, skepticResult.content, round, synthConfidenceByRound);

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
      // Record the confidence the synthesizer just produced so subsequent
      // turns (and the next round) see it via `convergence_delta`.
      if (synthResult.meta !== undefined) {
        synthConfidenceByRound.set(round, synthResult.meta.confidence);
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
        recordTurn(blackboard, redAgent, redResult.content, round, synthConfidenceByRound);
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
    }

    // -------------------------------------------------------------------- //
    // Compute final outcome
    // -------------------------------------------------------------------- //
    const residueScore = computeResidueScore(blackboard.conflicts);
    const resolved = blackboard.conflicts.length === 0 ||
      blackboard.conflicts.every((c) => c.resolved);

    const split: SplitSummary | null =
      synthesis === null
        ? buildSplitSummary(blackboard.turns, residueScore)
        : null;

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

    return {
      topic,
      ...(normalizedContext !== undefined ? { context: normalizedContext } : {}),
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

    const blackboard: Blackboard = {
      topic,
      turns: [],
      conflicts: [],
      metadata: {
        active_preset: topology.activePreset.id,
      },
      ...(normalizedContext !== undefined ? { context: normalizedContext } : {}),
    };

    let terminationReason: TerminationReason = 'max_rounds';
    let synthesis: string | null = null;
    let totalRounds = 0;
    const events: SystemEvent[] = [];
    // Tracks each round's synthesizer confidence so `recordTurn` can attach
    // a stable `convergence_delta` to every fresh turn without re-walking
    // the transcript. Mirrors the `run()` method.
    const synthConfidenceByRound = new Map<number, number>();

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
      // Step phase: walk the preset's declared step list in order.
      // ------------------------------------------------------------------ //
      for (const step of topology.activePreset.steps) {
        // Round-1-only Proposer: the Proposer opens the deliberation; on
        // subsequent rounds the synthesizer's reconciliation carries the
        // thread forward via the blackboard. This matches the legacy
        // pipeline's behavior and is what the byte-identical Debate
        // regression test pins.
        if (round > 1 && step.neurotype === 'proposer') continue;

        const agent = resolveNeurotype(step);
        const result = await agent.generate(blackboard);
        recordTurn(blackboard, agent, result.content, round, synthConfidenceByRound);

        // Out-of-band Sentry after every step. The loader has already
        // forbidden Sentry from appearing in steps, so this is the ONLY
        // place Sentry runs during the step phase.
        const sentryStepResult = await sentry.generate(blackboard);
        if (sentryStepResult.signal === 'collapse_detected') {
          events.push({
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
        } = {
          logger,
          synthConfidenceByRound,
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
        events.push({
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

        events.push({
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
          events.push({
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
      // Record the confidence the synthesizer just produced so subsequent
      // turns (and the next round) see it via `convergence_delta`.
      if (synthResult.meta !== undefined) {
        synthConfidenceByRound.set(round, synthResult.meta.confidence);
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

      // Out-of-band Sentry after synthesizer.
      const sentryPostSynthResult = await sentry.generate(blackboard);
      if (sentryPostSynthResult.signal === 'collapse_detected') {
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
      // RedAgent injection at interval (structural infrastructure).
      // ------------------------------------------------------------------ //
      if (round % redAgentInterval === 0) {
        const redResult = await redAgent.generate(blackboard);
        recordTurn(blackboard, redAgent, redResult.content, round, synthConfidenceByRound);
        events.push({
          round,
          kind: 'red_agent.injection',
          message: redResult.content,
          timestamp: new Date().toISOString(),
        });
      }

      // PAR-10: round_end lifecycle marker for a complete round iteration.
      events.push({
        round,
        kind: 'round_end',
        message: `Round ${round} ended.`,
        timestamp: new Date().toISOString(),
      });
    }

    const residueScore = computeResidueScore(blackboard.conflicts);
    const resolved = blackboard.conflicts.length === 0 ||
      blackboard.conflicts.every((c) => c.resolved);

    const split: SplitSummary | null =
      synthesis === null
        ? buildSplitSummary(blackboard.turns, residueScore)
        : null;

    // PAR-10: termination lifecycle marker. Always emitted, regardless of
    // why the loop exited.
    events.push({
      round: totalRounds,
      kind: 'termination',
      message: `Deliberation terminated after round ${totalRounds} (${terminationReason}).`,
      timestamp: new Date().toISOString(),
      data: { reason: terminationReason, totalRounds },
    });

    const completedAt = new Date().toISOString();

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
    };
  }
}
