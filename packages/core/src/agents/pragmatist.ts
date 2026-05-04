import type { Blackboard } from '../types.js';
import { AgentBase, type AgentResult } from './base.js';
import { buildPromptHeader, capWithMeta } from './utils.js';

export const PRAGMATIST_SYSTEM_PROMPT =
  'You are the Pragmatist. Your posture is constraint-first: reason from "what is actually doable" rather than "what is ideal." ' +
  'Identify at least one binding real-world constraint the proposal must navigate — resources, time, social/political feasibility, or technical limits — and use the literal phrase "binding constraint" when naming it. ' +
  'When the maximalist version of the proposal is infeasible, suggest a minimum viable variant that respects the binding constraints and label it "minimum viable variant". ' +
  'Stay within 200 words. Output plain prose only — no markdown headers, bold, italics, or bullet lists.';

export class PragmatistAgent extends AgentBase {
  readonly role = 'Pragmatist';
  readonly neurotype = 'pragmatist';
  readonly posture = 'constraint-first';

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
    );
    const userPrompt = recentTurns.length > 0
      ? `${header}\n\nRecent discussion:\n\n${recentTurns}`
      : header;

    // PAR-23: forward adapter telemetry onto the returned AgentResult.
    // PAR-25: failover-wrapped call.
    const raw = await this.generateWithFailover(userPrompt, PRAGMATIST_SYSTEM_PROMPT);
    return capWithMeta(raw);
  }
}
