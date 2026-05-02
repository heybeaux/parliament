import type { ModelAdapter } from '../adapters/base.js';
import type { Blackboard } from '../types.js';
import type { Agent, AgentResult } from './base.js';
import { buildPromptHeader, enforceWordCap } from './utils.js';

const SYSTEM_PROMPT =
  'You are a rigorous critic. Identify logical leaps, unsupported assumptions, and errors in the previous response. Stay within 200 words. Output plain prose only — no markdown headers, bold, italics, or bullet lists.';

/**
 * Lightweight markers used to detect that the Skeptic's free-form output
 * contains an explicit, on-topic disagreement. Word-boundary matching keeps
 * this from over-firing on substrings.
 *
 * (Chosen over a structured `<conflict>...</conflict>` tag because parsing
 * a natural-language critique for explicit dissent markers requires no
 * prompt change and stays robust when the local model ignores formatting
 * directives — which is the common case for the small open models this
 * project is calibrated against.)
 */
const DISAGREEMENT_PATTERNS: RegExp[] = [
  /\bI\s+disagree\b/i,
  /\bI\s+object\b/i,
  /\bdisagree(?:s|ment)?\b/i,
  /\bobject(?:ion|ions)?\b/i,
  /\bhowever\b/i,
  /\bcontradict(?:s|ion|ory)?\b/i,
  /\bunsupported\b/i,
  /\bflaw(?:ed|s)?\b/i,
  /\bincorrect\b/i,
  /\bfalse\b/i,
  /\bbut\s+(?:this|that|the\s+claim|the\s+argument)\b/i,
];

/** Returns true iff `text` contains explicit disagreement language. */
export function containsDisagreement(text: string): boolean {
  return DISAGREEMENT_PATTERNS.some((pattern) => pattern.test(text));
}

export class SkepticAgent implements Agent {
  readonly role = 'Skeptic';
  readonly neurotype = 'critical';
  readonly posture = 'adversarial';
  readonly modelName: string;

  constructor(private readonly adapter: ModelAdapter) {
    this.modelName = adapter.modelName;
  }

  async generate(blackboard: Blackboard): Promise<AgentResult> {
    const recentTurns = blackboard.turns
      .slice(-4)
      .map((t) => `[${t.agent}]: ${t.content}`)
      .join('\n\n');

    const header = buildPromptHeader(
      blackboard.topic,
      blackboard.context,
      blackboard.sources,
    );
    const userPrompt = recentTurns.length > 0
      ? `${header}\n\nDiscussion to critique:\n\n${recentTurns}`
      : header;

    const raw = await this.adapter.generate(userPrompt, SYSTEM_PROMPT);
    const result = enforceWordCap(raw);

    // Only record a conflict when the Skeptic actually disagreed. Prior
    // behaviour pushed a conflict every turn unconditionally, which made
    // residueScore a function of round count rather than substantive
    // disagreement.
    if (containsDisagreement(result.content)) {
      const lastTurn = blackboard.turns[blackboard.turns.length - 1];
      const lastAgent = lastTurn?.agent ?? 'Unknown';

      blackboard.conflicts.push({
        between: ['Skeptic', lastAgent],
        description: result.content,
        resolved: false,
      });
    }

    return result;
  }
}
