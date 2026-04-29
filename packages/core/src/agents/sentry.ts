import type { ModelAdapter } from '../adapters/base.js';
import type { Blackboard, SentrySignal } from '../types.js';
import { jaccardSimilarity } from './utils.js';

/** Similarity threshold above which two turns are considered an echo/collapse. */
const COLLAPSE_THRESHOLD = 0.95;

/**
 * Minimum number of turns per role before echo detection is meaningful.
 * Each role needs at least 2 turns in history to compare for repetition,
 * and with 3 roles that means at least 6 total turns.
 */
const MIN_TURNS_FOR_ECHO_CHECK = 6;

export interface SentryResult {
  signal: SentrySignal;
  reason?: string;
}

export class SentryAgent {
  readonly role = 'Sentry';
  readonly neurotype = 'monitoring';
  readonly modelName: string;

  constructor(private readonly adapter: ModelAdapter) {
    this.modelName = adapter.modelName;
  }

  async generate(blackboard: Blackboard): Promise<SentryResult> {
    const turns = blackboard.turns;

    // Only check for echo once each role has spoken at least twice.
    // LLM-based classification was producing false positives, so we rely
    // solely on the programmatic Jaccard similarity check.
    if (turns.length < MIN_TURNS_FOR_ECHO_CHECK) {
      return { signal: 'ok' };
    }

    // Find the previous turn from the same agent as the most recent turn
    // and check if they're nearly identical (agent repeating itself verbatim).
    const last = turns[turns.length - 1]!;
    for (let i = turns.length - 2; i >= 0; i--) {
      const candidate = turns[i]!;
      if (candidate.agent === last.agent) {
        const similarity = jaccardSimilarity(last.content, candidate.content);
        if (similarity > COLLAPSE_THRESHOLD) {
          return {
            signal: 'collapse_detected',
            reason: `Echo loop: ${last.agent} repeated itself with similarity ${similarity.toFixed(3)}`,
          };
        }
        break;
      }
    }

    return { signal: 'ok' };
  }
}
