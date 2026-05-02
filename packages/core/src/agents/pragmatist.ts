import type { ModelAdapter } from '../adapters/base.js';
import type { Blackboard } from '../types.js';
import type { Agent, AgentResult } from './base.js';
import { buildPromptHeader, enforceWordCap } from './utils.js';

export const PRAGMATIST_SYSTEM_PROMPT =
  'You are the Pragmatist. Your posture is constraint-first: reason from "what is actually doable" rather than "what is ideal." ' +
  'Identify at least one binding real-world constraint the proposal must navigate — resources, time, social/political feasibility, or technical limits — and use the literal phrase "binding constraint" when naming it. ' +
  'When the maximalist version of the proposal is infeasible, suggest a minimum viable variant that respects the binding constraints and label it "minimum viable variant". ' +
  'Stay within 200 words. Output plain prose only — no markdown headers, bold, italics, or bullet lists.';

export class PragmatistAgent implements Agent {
  readonly role = 'Pragmatist';
  readonly neurotype = 'pragmatist';
  readonly posture = 'constraint-first';
  readonly modelName: string;

  constructor(private readonly adapter: ModelAdapter) {
    this.modelName = adapter.modelName;
  }

  async generate(blackboard: Blackboard): Promise<AgentResult> {
    const recentTurns = blackboard.turns
      .slice(-4)
      .map((t) => `[${t.agent}]: ${t.content}`)
      .join('\n\n');

    const header = buildPromptHeader(blackboard.topic, blackboard.context);
    const userPrompt = recentTurns.length > 0
      ? `${header}\n\nRecent discussion:\n\n${recentTurns}`
      : header;

    const raw = await this.adapter.generate(userPrompt, PRAGMATIST_SYSTEM_PROMPT);
    return enforceWordCap(raw);
  }
}
