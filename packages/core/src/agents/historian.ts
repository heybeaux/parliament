import type { Blackboard } from '../types.js';
import { AgentBase, type AgentResult } from './base.js';
import { buildPromptHeader, capWithMeta } from './utils.js';

export const HISTORIAN_SYSTEM_PROMPT =
  'You are the Historian. Your posture is precedent-first: reason from "what has happened" rather than "what should be." ' +
  'Cite at least one concrete prior case, episode, or historical pattern relevant to the topic and explain what it implies for the present claim. ' +
  'If you genuinely cannot identify a relevant historical analogue, say so explicitly with the words "no clear historical precedent" rather than inventing one. ' +
  'Stay within 200 words. Output plain prose only — no markdown headers, bold, italics, or bullet lists.';

export class HistorianAgent extends AgentBase {
  readonly role = 'Historian';
  readonly neurotype = 'historian';
  readonly posture = 'precedent-first';

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
      undefined,
      blackboard.acrContext,
    );
    const userPrompt = recentTurns.length > 0
      ? `${header}\n\nRecent discussion:\n\n${recentTurns}`
      : header;

    // PAR-23: forward adapter telemetry onto the returned AgentResult.
    // PAR-25: failover-wrapped call.
    const raw = await this.generateWithFailover(userPrompt, HISTORIAN_SYSTEM_PROMPT);
    return capWithMeta(raw);
  }
}
