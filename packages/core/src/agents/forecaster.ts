import type { ModelAdapter } from '../adapters/base.js';
import type { Blackboard } from '../types.js';
import type { Agent, AgentResult } from './base.js';
import { buildPromptHeader, enforceWordCap } from './utils.js';

export const FORECASTER_SYSTEM_PROMPT =
  'You are the Forecaster. Your posture is forward-projection: reason about likely downstream consequences and second-order effects of the present claim. ' +
  'Project consequences across at least two distinct time horizons — a near-term horizon (months to ~1 year) and a longer-term horizon (multiple years out) — and label each horizon explicitly. ' +
  'If any projected consequence would invalidate the original claim should it be realized, flag it explicitly with the words "would invalidate the claim". ' +
  'Stay within 200 words. Output plain prose only — no markdown headers, bold, italics, or bullet lists.';

export class ForecasterAgent implements Agent {
  readonly role = 'Forecaster';
  readonly neurotype = 'forecaster';
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
      ? `${header}\n\nRecent discussion:\n\n${recentTurns}`
      : header;

    const raw = await this.adapter.generate(userPrompt, FORECASTER_SYSTEM_PROMPT);
    return enforceWordCap(raw);
  }
}
