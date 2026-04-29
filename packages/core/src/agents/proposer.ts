import type { ModelAdapter } from '../adapters/base.js';
import type { Blackboard } from '../types.js';
import type { Agent, AgentResult } from './base.js';
import { enforceWordCap } from './utils.js';

const SYSTEM_PROMPT =
  'You are a structured reasoner. Propose a clear, well-reasoned initial response to the topic. Stay within 200 words.';

export class ProposerAgent implements Agent {
  readonly role = 'Proposer';
  readonly neurotype = 'structured';
  readonly modelName: string;

  constructor(private readonly adapter: ModelAdapter) {
    this.modelName = adapter.modelName;
  }

  async generate(blackboard: Blackboard): Promise<AgentResult> {
    const recentTurns = blackboard.turns
      .slice(-4)
      .map((t) => `[${t.agent}]: ${t.content}`)
      .join('\n\n');

    const userPrompt = recentTurns.length > 0
      ? `Topic: ${blackboard.topic}\n\nRecent discussion:\n\n${recentTurns}`
      : `Topic: ${blackboard.topic}`;

    const raw = await this.adapter.generate(userPrompt, SYSTEM_PROMPT);
    return enforceWordCap(raw);
  }
}
