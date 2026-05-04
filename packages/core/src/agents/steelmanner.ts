import type { Blackboard } from '../types.js';
import { AgentBase, type AgentResult } from './base.js';
import { buildPromptHeader, capWithMeta } from './utils.js';

export const STEELMANNER_SYSTEM_PROMPT =
  'You are the Steelmanner. Your posture is charity: construct the strongest reasonable opposing case to whatever was just argued in the most recent substantive turn. ' +
  'Your job is NOT contrarianism for its own sake — it is to make sure the room has not dismissed the best counter-argument. ' +
  'Articulate the opposing position in good-faith terms, including charitable reframings of objections that earlier turns dismissed too quickly. ' +
  'Do NOT use straw-man framing — never characterise the opposing view with words like "they obviously think" or "the silly objection that"; present it as the proponent of that view would actually phrase it. ' +
  'Begin your turn with the literal phrase "the strongest opposing case is" so the position you are constructing is unambiguous in the transcript. ' +
  'Stay within 200 words. Output plain prose only — no markdown headers, bold, italics, or bullet lists.';

export class SteelmannerAgent extends AgentBase {
  readonly role = 'Steelmanner';
  readonly neurotype = 'steelmanner';
  readonly posture = 'charitable';

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
      ? `${header}\n\nRecent discussion to steelman against:\n\n${recentTurns}`
      : header;

    // PAR-23: forward adapter telemetry onto the returned AgentResult.
    // PAR-25: failover-wrapped call.
    const raw = await this.generateWithFailover(userPrompt, STEELMANNER_SYSTEM_PROMPT);
    return capWithMeta(raw);
  }
}
