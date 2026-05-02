import type { ModelAdapter } from '../adapters/base.js';
import type { Blackboard } from '../types.js';
import type { Agent, AgentResult } from './base.js';
import { buildPromptHeader, capWithMeta } from './utils.js';

const SYSTEM_PROMPT =
  'You are a structured reasoner. Propose a clear, well-reasoned initial response to the topic. Stay within 200 words. Output plain prose only — no markdown headers, bold, italics, or bullet lists.';

export class ProposerAgent implements Agent {
  readonly role = 'Proposer';
  readonly neurotype = 'structured';
  readonly posture = 'structured-reasoner';
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

    // PAR-23: `capWithMeta` forwards adapter telemetry (latency, tokens,
    // cost, provider) onto the AgentResult so the engine can persist it
    // onto Turn.meta. The 200-word cap is applied to the prose only.
    const raw = await this.adapter.generate(userPrompt, SYSTEM_PROMPT);
    return capWithMeta(raw);
  }
}
