import type { ModelAdapter } from '../adapters/base.js';
import type { Blackboard, Turn } from '../types.js';
import type { Agent, AgentResult } from './base.js';
import { buildPromptHeader, enforceWordCap } from './utils.js';

/**
 * Round-1 system prompt. With no prior synthesis to invert, the agent
 * surfaces and attacks the *least-defended implicit assumption* underneath
 * the Proposer's claim — staying true to the consensus-tracking spirit
 * (rather than collapsing into a second Skeptic that just attacks the
 * stated thesis).
 *
 * The few-shot example shows the desired move: read the claim, name an
 * unstated assumption, attack it directly.
 */
export const DEVILS_ADVOCATE_ROUND1_SYSTEM_PROMPT =
  'You are the Devil\'s Advocate. This is Round 1: there is no prior synthesis or dominant view to invert yet. ' +
  'Read the Proposer\'s claim and identify an *unstated assumption* it relies on — the load-bearing premise that has not been argued for, only presumed. Then attack that unstated assumption directly. ' +
  'Do NOT attack the stated thesis itself — the Skeptic will cover that. Your job is the angle the room has not yet noticed. ' +
  'Open your turn with the literal phrase "the unstated assumption is" so the implicit premise you are targeting is unambiguous in the transcript.\n\n' +
  'Few-shot example:\n' +
  '  Proposer claim: "AI systems should be regulated to prevent harm."\n' +
  '  Devil\'s Advocate: "the unstated assumption is that current regulators have the technical literacy to write rules that actually constrain frontier systems. ' +
  'Strip that premise and the proposal becomes regulatory theatre — symbolic compliance from systems whose internals neither the regulators nor the regulated can audit."\n\n' +
  'Stay within 200 words. Output plain prose only — no markdown headers, bold, italics, or bullet lists.';

/**
 * Round-2+ system prompt. The agent inverts the room's currently dominant
 * view: if critique has dominated the recent turns, defend the original
 * claim; if the original claim is being affirmed, attack it; if a synthesis
 * has formed, attack the synthesis. Consensus-tracking, not fixed-target.
 */
export const DEVILS_ADVOCATE_ROUND2_SYSTEM_PROMPT =
  'You are the Devil\'s Advocate. This is Round 2 or later: a dominant view has formed in the recent turns. ' +
  'Identify what that dominant view is — affirmation of the Proposer\'s claim, critique of it, or an emerging synthesis — and argue against it. ' +
  'You are consensus-tracking, NOT fixed-target. If critique has dominated recently, defend the original claim. If affirmation has dominated, attack it. If a synthesis is forming, attack the synthesis. ' +
  'Open your turn with the literal phrase "the dominant view in this round is" followed by your read of what that view is, then deliver the inversion. ' +
  'Stay within 200 words. Output plain prose only — no markdown headers, bold, italics, or bullet lists.';

/**
 * Detect whether this is Round 1 (no prior view to invert) or later.
 *
 * Round 1: empty transcript OR all turns share round=1 AND there are at
 * most two turns total (the room has not formed a view yet).
 *
 * Round 2+: any turn carries round >= 2, OR there are more than two turns
 * (heuristic: by the third turn the room has signalled where it is heading
 * even if the engine still labels everything round=1).
 */
export function isRoundOne(turns: Turn[]): boolean {
  if (turns.length === 0) return true;
  const maxRound = turns.reduce((m, t) => (t.round > m ? t.round : m), 0);
  if (maxRound >= 2) return false;
  if (turns.length > 2) return false;
  return true;
}

export class DevilsAdvocateAgent implements Agent {
  readonly role = 'DevilsAdvocate';
  readonly neurotype = 'devils-advocate';
  readonly posture = 'contrarian';
  readonly modelName: string;

  constructor(private readonly adapter: ModelAdapter) {
    this.modelName = adapter.modelName;
  }

  async generate(blackboard: Blackboard): Promise<AgentResult> {
    const recentTurns = blackboard.turns
      .slice(-4)
      .map((t) => `[${t.agent}]: ${t.content}`)
      .join('\n\n');

    const header = buildPromptHeader(blackboard.topic);
    const round1 = isRoundOne(blackboard.turns);
    const systemPrompt = round1
      ? DEVILS_ADVOCATE_ROUND1_SYSTEM_PROMPT
      : DEVILS_ADVOCATE_ROUND2_SYSTEM_PROMPT;

    const userPrompt = recentTurns.length > 0
      ? `${header}\n\nRecent discussion:\n\n${recentTurns}`
      : header;

    const raw = await this.adapter.generate(userPrompt, systemPrompt);
    return enforceWordCap(raw);
  }
}
