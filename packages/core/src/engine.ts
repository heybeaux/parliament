import type {
  Blackboard,
  DeliberationResult,
  SplitSummary,
  SynthesizerMeta,
  TerminationReason,
  Turn,
} from './types.js';
import type { Agent } from './agents/base.js';
import type { SynthesizerAgent, SynthesizerResult } from './agents/synthesizer.js';
import type { SentryAgent } from './agents/sentry.js';
import type { TopologyConfig, TopologyStep } from './topology/index.js';

export interface DeliberationConfig {
  /** Maximum number of deliberation rounds. Default: 5. */
  maxRounds: number;
  /** Inject RedAgent every N rounds. Default: 3. */
  redAgentInterval: number;
  /** Synthesizer confidence threshold to declare consensus. Default: 0.7. */
  confidenceThreshold: number;
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
 */
function recordTurn(
  blackboard: Blackboard,
  agent: Agent | SentryAgent | SynthesizerAgent,
  content: string,
  round: number,
  meta?: SynthesizerMeta,
): void {
  const turn: Turn = {
    agent: agent.role,
    neurotype: agent.neurotype,
    model: agent.modelName,
    content,
    timestamp: new Date().toISOString(),
    round,
    word_count: countWords(content),
  };
  if (meta !== undefined) {
    turn.meta = meta;
  }
  blackboard.turns.push(turn);
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

    const blackboard: Blackboard = {
      topic,
      turns: [],
      conflicts: [],
      metadata: {},
    };

    let terminationReason: TerminationReason = 'max_rounds';
    let synthesis: string | null = null;
    let totalRounds = 0;

    for (let round = 1; round <= maxRounds; round++) {
      totalRounds = round;

      // ------------------------------------------------------------------ //
      // Step 1: Proposer (round 1 only)
      // ------------------------------------------------------------------ //
      if (round === 1) {
        const proposerResult = await proposer.generate(blackboard);
        recordTurn(blackboard, proposer, proposerResult.content, round);
      }

      // ------------------------------------------------------------------ //
      // Step 2: Skeptic — always generates; appends Conflict to blackboard.
      // (SkepticAgent already mutates blackboard.conflicts internally, but we
      //  call generate to drive that side-effect and record the turn.)
      // ------------------------------------------------------------------ //
      const skepticResult = await skeptic.generate(blackboard);
      recordTurn(blackboard, skeptic, skepticResult.content, round);

      // ------------------------------------------------------------------ //
      // Step 3: Sentry check — terminate on collapse_detected
      // ------------------------------------------------------------------ //
      const sentryResult1 = await sentry.generate(blackboard);
      if (sentryResult1.signal === 'collapse_detected') {
        terminationReason = 'echo_loop';
        break;
      }

      // ------------------------------------------------------------------ //
      // Step 4: Synthesizer — terminate when the synthesizer explicitly votes
      // consensus AND its calibrated confidence clears the threshold.
      // ------------------------------------------------------------------ //
      const synthResult = await synthesizer.generate(blackboard);
      recordTurn(blackboard, synthesizer, synthResult.content, round, synthResult.meta);

      if (shouldTerminateOnConsensus(synthResult, confidenceThreshold)) {
        synthesis = synthResult.content;
        terminationReason = 'consensus';
        break;
      }

      // ------------------------------------------------------------------ //
      // Step 5: Sentry check again after Synthesizer
      // ------------------------------------------------------------------ //
      const sentryResult2 = await sentry.generate(blackboard);
      if (sentryResult2.signal === 'collapse_detected') {
        terminationReason = 'echo_loop';
        break;
      }

      // ------------------------------------------------------------------ //
      // Step 6: RedAgent injection at interval
      // ------------------------------------------------------------------ //
      if (round % redAgentInterval === 0) {
        const redResult = await redAgent.generate(blackboard);
        recordTurn(blackboard, redAgent, redResult.content, round);
      }
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

    const completedAt = new Date().toISOString();

    return {
      topic,
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

    const blackboard: Blackboard = {
      topic,
      turns: [],
      conflicts: [],
      metadata: {
        active_preset: topology.activePreset.id,
      },
    };

    let terminationReason: TerminationReason = 'max_rounds';
    let synthesis: string | null = null;
    let totalRounds = 0;

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

      // ------------------------------------------------------------------ //
      // Step phase: walk the preset's declared step list in order.
      // ------------------------------------------------------------------ //
      for (const step of topology.activePreset.steps) {
        const agent = resolveNeurotype(step);
        const result = await agent.generate(blackboard);
        recordTurn(blackboard, agent, result.content, round);

        // Out-of-band Sentry after every step. The loader has already
        // forbidden Sentry from appearing in steps, so this is the ONLY
        // place Sentry runs during the step phase.
        const sentryStepResult = await sentry.generate(blackboard);
        if (sentryStepResult.signal === 'collapse_detected') {
          terminationReason = 'echo_loop';
          break roundLoop;
        }
      }

      // ------------------------------------------------------------------ //
      // Synthesizer (structural infrastructure — not a step).
      // ------------------------------------------------------------------ //
      const synthResult = await synthesizer.generate(blackboard);
      recordTurn(blackboard, synthesizer, synthResult.content, round, synthResult.meta);

      if (shouldTerminateOnConsensus(synthResult, confidenceThreshold)) {
        synthesis = synthResult.content;
        terminationReason = 'consensus';
        break;
      }

      // Out-of-band Sentry after synthesizer.
      const sentryPostSynthResult = await sentry.generate(blackboard);
      if (sentryPostSynthResult.signal === 'collapse_detected') {
        terminationReason = 'echo_loop';
        break;
      }

      // ------------------------------------------------------------------ //
      // RedAgent injection at interval (structural infrastructure).
      // ------------------------------------------------------------------ //
      if (round % redAgentInterval === 0) {
        const redResult = await redAgent.generate(blackboard);
        recordTurn(blackboard, redAgent, redResult.content, round);
      }
    }

    const residueScore = computeResidueScore(blackboard.conflicts);
    const resolved = blackboard.conflicts.length === 0 ||
      blackboard.conflicts.every((c) => c.resolved);

    const split: SplitSummary | null =
      synthesis === null
        ? buildSplitSummary(blackboard.turns, residueScore)
        : null;

    const completedAt = new Date().toISOString();

    return {
      topic,
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
    };
  }
}
