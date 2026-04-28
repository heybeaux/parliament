import type { ModelAdapter } from '../adapters/base.js';
import type { Blackboard } from '../types.js';
import type { Agent, AgentResult } from './base.js';
import { enforceWordCap } from './utils.js';

const SYSTEM_PROMPT =
  'You are a rigorous critic. Identify logical leaps, unsupported assumptions, and errors in the previous response. Stay within 100 words.';

export class SkepticAgent implements Agent {
  readonly role = 'Skeptic';
  readonly neurotype = 'critical';

  constructor(private readonly adapter: ModelAdapter) {}

  async generate(blackboard: Blackboard): Promise<AgentResult> {
    const recentTurns = blackboard.turns
      .slice(-4)
      .map((t) => `[${t.agent}]: ${t.content}`)
      .join('\n\n');

    const userPrompt = recentTurns.length > 0
      ? `Topic: ${blackboard.topic}\n\nDiscussion to critique:\n\n${recentTurns}`
      : `Topic: ${blackboard.topic}`;

    const raw = await this.adapter.generate(userPrompt, SYSTEM_PROMPT);
    const result = enforceWordCap(raw);

    // Determine the last speaking agent for the conflict record.
    const lastTurn = blackboard.turns[blackboard.turns.length - 1];
    const lastAgent = lastTurn?.agent ?? 'Unknown';

    // All Skeptic output is critique — always record a conflict.
    blackboard.conflicts.push({
      between: ['Skeptic', lastAgent],
      description: result.content.slice(0, 100),
      resolved: false,
    });

    return result;
  }
}
