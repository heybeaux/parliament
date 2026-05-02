import type { ModelAdapter } from '../adapters/base.js';
import type { Blackboard } from '../types.js';
import type { Agent, AgentResult } from './base.js';
import { buildPromptHeader, enforceWordCap } from './utils.js';

export const HISTORIAN_SYSTEM_PROMPT =
  'You are the Historian. Your posture is precedent-first: reason from "what has happened" rather than "what should be." ' +
  'Cite at least one concrete prior case, episode, or historical pattern relevant to the topic and explain what it implies for the present claim. ' +
  'If you genuinely cannot identify a relevant historical analogue, say so explicitly with the words "no clear historical precedent" rather than inventing one. ' +
  'Stay within 200 words. Output plain prose only — no markdown headers, bold, italics, or bullet lists.';

export class HistorianAgent implements Agent {
  readonly role = 'Historian';
  readonly neurotype = 'historian';
  readonly posture = 'precedent-first';
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

    const raw = await this.adapter.generate(userPrompt, HISTORIAN_SYSTEM_PROMPT);
    return enforceWordCap(raw);
  }
}
