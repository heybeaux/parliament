import type { ModelAdapter } from '../adapters/base.js';
import type { Blackboard, SentrySignal } from '../types.js';
import { jaccardSimilarity } from './utils.js';
import { detectEchoLoop } from '../osi.js';

/** Similarity threshold above which two turns are considered an echo/collapse (legacy fallback). */
const COLLAPSE_THRESHOLD = 0.95;

/**
 * Minimum number of turns per role before echo detection is meaningful.
 * Each role needs at least 2 turns in history to compare for repetition,
 * and with 3 roles that means at least 6 total turns.
 */
const MIN_TURNS_FOR_ECHO_CHECK = 6;

/** Default Jaccard similarity threshold used when OSI is enabled but no
 *  config-supplied value is available. Mirrors `parliament.toml`. */
const DEFAULT_OSI_SIMILARITY_THRESHOLD = 0.85;

/** Default window size for the OSI detector — matches osi.detectEchoLoop. */
const DEFAULT_OSI_WINDOW = 3;

export interface SentryResult {
  signal: SentrySignal;
  reason?: string;
}

export interface SentryOptions {
  /**
   * When true, Sentry uses `detectEchoLoop` from osi.ts as the source of
   * truth for collapse decisions. When false, falls back to the legacy
   * 0.95-cosine same-agent comparison.
   */
  osiEnabled?: boolean;
  /**
   * Jaccard similarity threshold (0..1) that maps to the underlying OSI
   * Jaccard-distance gate via `1 - similarity`. Higher = stricter
   * (only near-identical repetition counts as echo).
   */
  osiSimilarityThreshold?: number;
  /** Window size passed to detectEchoLoop. */
  osiWindow?: number;
}

export class SentryAgent {
  readonly role = 'Sentry';
  readonly neurotype = 'monitoring';
  readonly modelName: string;
  private readonly osiEnabled: boolean;
  private readonly osiDistanceThreshold: number;
  private readonly osiWindow: number;

  constructor(private readonly adapter: ModelAdapter, options: SentryOptions = {}) {
    this.modelName = adapter.modelName;
    this.osiEnabled = options.osiEnabled ?? false;
    const sim = options.osiSimilarityThreshold ?? DEFAULT_OSI_SIMILARITY_THRESHOLD;
    // detectEchoLoop expects a distance (1 - similarity).
    this.osiDistanceThreshold = 1 - sim;
    this.osiWindow = options.osiWindow ?? DEFAULT_OSI_WINDOW;
  }

  async generate(blackboard: Blackboard): Promise<SentryResult> {
    const turns = blackboard.turns;

    // OSI path — primary detector when enabled. Operates on the per-role
    // transcript (each agent's own utterances over the run); detectEchoLoop
    // returns true only when *every* agent visible in the recent window is
    // repeating itself, which is exactly what an irresolvable debate looks
    // like.
    if (this.osiEnabled) {
      if (turns.length < this.osiWindow) {
        return { signal: 'ok' };
      }
      const collapsed = detectEchoLoop(turns, this.osiWindow, this.osiDistanceThreshold);
      if (collapsed) {
        return {
          signal: 'collapse_detected',
          reason: `OSI echo loop: all agents in last ${this.osiWindow} turns below similarity threshold`,
        };
      }
      return { signal: 'ok' };
    }

    // Legacy fallback: only used when osi_enabled = false. Checks whether
    // the two most recent same-agent turns are nearly identical (>=0.95
    // Jaccard similarity).
    if (turns.length < MIN_TURNS_FOR_ECHO_CHECK) {
      return { signal: 'ok' };
    }

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
