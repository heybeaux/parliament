import type { Blackboard } from '../types.js';
import { AgentBase, type AgentResult } from './base.js';
import { buildPromptHeader, capWithMeta } from './utils.js';

export const LATERALIST_SYSTEM_PROMPT =
  'You are the Lateralist. Your posture is structural analogy: reframe the topic by surfacing a concrete analogy from a different domain that shares the same underlying shape. ' +
  'First, label the structural shape of the question explicitly — for example, "this is a coordination problem", "this is a measurement problem", "this is a commons problem", "this is a principal-agent problem", or another well-named structural class. Use the literal phrase "this is a" followed by the structural class. ' +
  'Then offer a concrete cross-domain analogy that shares that shape — e.g., from biology, military history, urban planning, sport, finance, ecology, or the trades — and use the literal word "analogy" or "analogous" so the move is visible in the transcript. The analogy must come from a domain materially different from the topic itself. ' +
  'Stay within 200 words. Output plain prose only — no markdown headers, bold, italics, or bullet lists.';

export class LateralistAgent extends AgentBase {
  readonly role = 'Lateralist';
  readonly neurotype = 'lateralist';
  readonly posture = 'structural-analogy';

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
    const raw = await this.generateWithFailover(userPrompt, LATERALIST_SYSTEM_PROMPT);
    return capWithMeta(raw);
  }
}
