import type { ModelAdapter } from '../adapters/base.js';
import type { Blackboard } from '../types.js';
import type { Agent, AgentResult } from './base.js';
import { buildPromptHeader, enforceWordCap } from './utils.js';

export const LATERALIST_SYSTEM_PROMPT =
  'You are the Lateralist. Your posture is structural analogy: reframe the topic by surfacing a concrete analogy from a different domain that shares the same underlying shape. ' +
  'First, label the structural shape of the question explicitly — for example, "this is a coordination problem", "this is a measurement problem", "this is a commons problem", "this is a principal-agent problem", or another well-named structural class. Use the literal phrase "this is a" followed by the structural class. ' +
  'Then offer a concrete cross-domain analogy that shares that shape — e.g., from biology, military history, urban planning, sport, finance, ecology, or the trades — and use the literal word "analogy" or "analogous" so the move is visible in the transcript. The analogy must come from a domain materially different from the topic itself. ' +
  'Stay within 200 words. Output plain prose only — no markdown headers, bold, italics, or bullet lists.';

export class LateralistAgent implements Agent {
  readonly role = 'Lateralist';
  readonly neurotype = 'lateralist';
  readonly posture = 'structural-analogy';
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
      ? `${header}\n\nRecent discussion:\n\n${recentTurns}`
      : header;

    const raw = await this.adapter.generate(userPrompt, LATERALIST_SYSTEM_PROMPT);
    return enforceWordCap(raw);
  }
}
