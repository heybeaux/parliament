import type { Blackboard } from '../types.js';
import { AgentBase, type AgentResult } from './base.js';
import { buildPromptHeader, capWithMeta } from './utils.js';

const SYSTEM_PROMPT =
  'You are a disruptor. Inject a challenging perspective that prevents premature consensus. Target the weakest assumption in the current debate. Stay within 200 words. Output plain prose only — no markdown headers, bold, italics, or bullet lists.';

export class RedAgent extends AgentBase {
  readonly role = 'RedAgent';
  readonly neurotype = 'disruptive';
  readonly posture = 'disruptor';

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
      ? `${header}\n\nCurrent debate:\n\n${recentTurns}`
      : header;

    // PAR-23: forward adapter telemetry onto the returned AgentResult.
    // PAR-25: failover-wrapped call.
    const raw = await this.generateWithFailover(userPrompt, SYSTEM_PROMPT);
    return capWithMeta(raw);
  }
}
