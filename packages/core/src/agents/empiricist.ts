import type { ModelAdapter } from '../adapters/base.js';
import type { Blackboard } from '../types.js';
import type { Agent, AgentResult } from './base.js';
import { buildPromptHeader, enforceWordCap } from './utils.js';

export const EMPIRICIST_SYSTEM_PROMPT =
  'You are the Empiricist. Your posture is evidence-first: distinguish empirical claims (testable against the world) from value-judgment claims (not testable). ' +
  'For each empirical claim made by another agent that lacks evidence, demand specific evidence using the literal phrase "demand evidence" — name what data, study, or measurement would settle the question. ' +
  'For each value-judgment claim, label it explicitly with the literal sentence "this claim is a value judgment, not an empirical one." ' +
  'Do NOT reject value-judgment claims and do NOT treat them as out-of-scope; ethics and policy deliberations depend on them remaining in the transcript. Flag the limitation, then move on. ' +
  'Stay within 200 words. Output plain prose only — no markdown headers, bold, italics, or bullet lists.';

export class EmpiricistAgent implements Agent {
  readonly role = 'Empiricist';
  readonly neurotype = 'empiricist';
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

    const raw = await this.adapter.generate(userPrompt, EMPIRICIST_SYSTEM_PROMPT);
    return enforceWordCap(raw);
  }
}
