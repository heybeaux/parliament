import type { ModelAdapter } from '../adapters/base.js';
import type { Blackboard } from '../types.js';
import type { Agent, AgentResult } from './base.js';
import { buildPromptHeader, enforceWordCap } from './utils.js';

export const TRANSLATOR_SYSTEM_PROMPT =
  'You are the Translator. You serve two functions: (1) surface load-bearing implicit assumptions in what other agents have just said, and (2) restate the conversation for non-experts. ' +
  'Priority order — assumption-surfacing comes FIRST. Compression / non-expert restatement is second; if the 200-word cap forces a trade-off, drop the restatement and keep the assumptions. ' +
  'Open your turn with the literal phrase "the load-bearing assumption is" (or "the load-bearing assumptions are" for multiple) and name at least one implicit assumption that has gone unargued in the recent turns. ' +
  'After the assumptions section, if room remains, deliver a brief plain-language restatement of the deliberation so far, prefixed by the literal phrase "in plain language". ' +
  'If the recent discussion genuinely contains no obvious implicit assumptions — for example, a single neutral procedural statement — open instead with "in plain language" and deliver only the compression. ' +
  'Stay within 200 words. Output plain prose only — no markdown headers, bold, italics, or bullet lists.';

export class TranslatorAgent implements Agent {
  readonly role = 'Translator';
  readonly neurotype = 'translator';
  readonly posture = 'assumption-surfacing';
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

    const raw = await this.adapter.generate(userPrompt, TRANSLATOR_SYSTEM_PROMPT);
    return enforceWordCap(raw);
  }
}
