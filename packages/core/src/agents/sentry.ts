import type { ModelAdapter } from '../adapters/base.js';
import type { Blackboard, SentrySignal } from '../types.js';
import { jaccardSimilarity } from './utils.js';

/** Similarity threshold above which two turns are considered an echo/collapse. */
const COLLAPSE_THRESHOLD = 0.95;

export interface SentryResult {
  signal: SentrySignal;
  reason?: string;
}

/**
 * Maps a raw model string (OK, SPECIALIST_NEEDED, COLLAPSE_DETECTED) to
 * the corresponding SentrySignal. Defaults to 'ok' if unrecognised.
 */
function parseSignal(raw: string): SentrySignal {
  const normalised = raw.trim().toUpperCase();
  if (normalised.includes('SPECIALIST_NEEDED')) return 'specialist_needed';
  if (normalised.includes('COLLAPSE_DETECTED')) return 'collapse_detected';
  return 'ok';
}

const SYSTEM_PROMPT =
  'You are a monitor. Check if the debate shows echo (same role agreeing with itself) or uncertainty collapse. Return ONLY one of: OK, SPECIALIST_NEEDED, COLLAPSE_DETECTED.';

export class SentryAgent {
  readonly role = 'Sentry';
  readonly neurotype = 'monitoring';

  constructor(private readonly adapter: ModelAdapter) {}

  async generate(blackboard: Blackboard): Promise<SentryResult> {
    const turns = blackboard.turns;

    // Programmatic check: if last 2 turns are from the same role and their
    // content similarity exceeds the threshold, return collapse immediately.
    if (turns.length >= 2) {
      const last = turns[turns.length - 1]!;
      const prev = turns[turns.length - 2]!;

      if (last.agent === prev.agent) {
        const similarity = jaccardSimilarity(last.content, prev.content);
        if (similarity > COLLAPSE_THRESHOLD) {
          return {
            signal: 'collapse_detected',
            reason: `Echo loop: ${last.agent} repeated itself with similarity ${similarity.toFixed(3)}`,
          };
        }
      }
    }

    // Fall back to model-based judgement.
    const recentTurns = turns
      .slice(-6)
      .map((t) => `[${t.agent}]: ${t.content}`)
      .join('\n\n');

    const userPrompt = recentTurns.length > 0
      ? `Topic: ${blackboard.topic}\n\nDebate so far:\n\n${recentTurns}`
      : `Topic: ${blackboard.topic}\n\nNo turns yet.`;

    const raw = await this.adapter.generate(userPrompt, SYSTEM_PROMPT);
    const signal = parseSignal(raw);

    return { signal, reason: raw.trim() };
  }
}
