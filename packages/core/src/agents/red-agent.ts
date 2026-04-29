import type { ModelAdapter } from '../adapters/base.js';
import type { Blackboard } from '../types.js';
import type { Agent, AgentResult } from './base.js';
import { buildPromptHeader, enforceWordCap } from './utils.js';

const SYSTEM_PROMPT =
  'You are a disruptor. Inject a challenging perspective that prevents premature consensus. Target the weakest assumption in the current debate. Stay within 200 words. Output plain prose only — no markdown headers, bold, italics, or bullet lists.';

export class RedAgent implements Agent {
  readonly role = 'RedAgent';
  readonly neurotype = 'disruptive';
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
    const userPrompt = recentTurns.length > 0
      ? `${header}\n\nCurrent debate:\n\n${recentTurns}`
      : header;

    const raw = await this.adapter.generate(userPrompt, SYSTEM_PROMPT);
    return enforceWordCap(raw);
  }
}
