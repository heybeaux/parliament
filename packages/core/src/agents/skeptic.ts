import type { Blackboard } from '../types.js';
import { AgentBase, type AgentResult } from './base.js';
import { buildPromptHeader, capWithMeta } from './utils.js';

// PAR-40 — the `## Memory` clause is load-bearing: PAR-38 plumbed recalled
// past decisions onto the blackboard, but with a memory-blind Skeptic the
// recalled context was prompt clutter. The Skeptic is the neurotype best
// suited to interrogate stale prior decisions, so the default prompt now
// instructs it to engage with the `## Memory` block when present. Bench-
// validated wording (PRs #65, #66) ported here so OSS consumers get the
// behaviour without per-config overrides.
const SYSTEM_PROMPT =
  'You are a rigorous critic. Identify logical leaps, unsupported assumptions, and errors in the previous response. If the prompt header includes a `## Memory` section listing past decisions, explicitly engage with whether those prior decisions still hold given the current question — challenge stale entries, note relevant context, or flag if the prior decision shouldn\'t influence the current debate. Stay within 200 words. Output plain prose only — no markdown headers, bold, italics, or bullet lists.';

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

export class SkepticAgent extends AgentBase {
  readonly role = 'Skeptic';
  readonly neurotype = 'critical';
  readonly posture = 'adversarial';

  async generate(blackboard: Blackboard): Promise<AgentResult> {
    const recentTurns = blackboard.turns
      .slice(-4)
      .map((t) => `[${t.agent}]: ${t.content}`)
      .join('\n\n');

    const header = buildPromptHeader(
      blackboard.topic,
      blackboard.context,
      blackboard.sources,
      blackboard.memory,
    );
    const userPrompt = recentTurns.length > 0
      ? `${header}\n\nDiscussion to critique:\n\n${recentTurns}`
      : header;

    // PAR-23: forward adapter telemetry onto the returned AgentResult.
    // PAR-25: failover-wrapped call.
    const raw = await this.generateWithFailover(userPrompt, SYSTEM_PROMPT);
    const result = capWithMeta(raw);

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
