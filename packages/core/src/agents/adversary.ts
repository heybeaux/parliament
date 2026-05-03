import type { Blackboard } from '../types.js';
import { AgentBase, type AgentResult } from './base.js';
import { buildPromptHeader, capWithMeta } from './utils.js';

/**
 * Adversary — attack-surface enumerator for software-development questions.
 *
 * Distinct from `devils-advocate` (which inverts the room's dominant view) and
 * from `skeptic` (which applies logic to a stated thesis). The Adversary's job
 * is to imagine the proposal *shipping* and enumerate what breaks: failure
 * modes, hidden costs, exploitable assumptions, and the highest-leverage
 * monitoring signal that would catch the failure earliest.
 *
 * Contract:
 *   - posture: "attack-surface enumerator" (not contrarian, not skeptical)
 *   - opens with "The strongest failure mode is" so the targeted attack
 *     surface is unambiguous in the transcript
 *   - names a concrete failure mode + the hidden cost or exploitable
 *     assumption underneath + the early-warning signal worth monitoring
 *   - 200-word cap, plain prose only
 */
export const ADVERSARY_SYSTEM_PROMPT =
  'You are the Adversary. Your job is attack-surface enumeration: imagine the proposal has SHIPPED and find what breaks first. ' +
  'Pick the single highest-leverage failure mode — the one that costs the most if you are wrong about it — and analyse it directly. ' +
  'Cover three things in tight prose: (1) the concrete failure mode (operational, security, abuse, debuggability, on-call burden, or data-corruption — pick the most damaging), ' +
  '(2) the hidden cost or exploitable assumption underneath it that the proposal has not argued for, ' +
  '(3) the earliest-warning signal you would monitor to catch it before it becomes irreversible. ' +
  'Open your turn with the literal phrase "The strongest failure mode is" so the targeted attack surface is unambiguous. ' +
  'Do NOT argue against the proposal as a whole and do NOT propose alternatives — your role is to surface the load-bearing failure mode the room has not yet examined. ' +
  'Stay within 200 words. Output plain prose only — no markdown headers, bold, italics, or bullet lists.';

export class AdversaryAgent extends AgentBase {
  readonly role = 'Adversary';
  readonly neurotype = 'adversary';
  readonly posture = 'attack-surface enumerator';

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
      ? `${header}\n\nRecent discussion:\n\n${recentTurns}`
      : header;

    const raw = await this.generateWithFailover(userPrompt, ADVERSARY_SYSTEM_PROMPT);
    return capWithMeta(raw);
  }
}
