import type { Blackboard } from '../types.js';
import { AgentBase, type AgentResult } from './base.js';
import { buildPromptHeader, capWithMeta } from './utils.js';

const SYSTEM_PROMPT =
  'You are a structured reasoner. Propose a clear, well-reasoned initial response to the topic. Stay within 200 words. Output plain prose only — no markdown headers, bold, italics, or bullet lists.';

export class ProposerAgent extends AgentBase {
  readonly role = 'Proposer';
  readonly neurotype = 'structured';
  readonly posture = 'structured-reasoner';

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
    // PAR-25: route the call through `generateWithFailover` so a primary
    // `ModelConnectionError` triggers a single fallback retry when the
    // engine has wired one.
    const raw = await this.generateWithFailover(userPrompt, SYSTEM_PROMPT);
    return capWithMeta(raw);
  }
}
