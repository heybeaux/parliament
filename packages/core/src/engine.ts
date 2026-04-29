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
 * Adds a turn to the blackboard after an agent generates output.
 *
 * `meta` is populated only by the synthesizer; for all other agents it is
 * omitted so the field stays undefined on the recorded Turn.
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
}
