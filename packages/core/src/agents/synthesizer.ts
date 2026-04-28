import type { ModelAdapter } from '../adapters/base.js';
import type { Blackboard } from '../types.js';
import type { Agent, AgentResult } from './base.js';
import { enforceWordCap } from './utils.js';

const SYSTEM_PROMPT =
  'You are a synthesizer. Attempt to reconcile conflicting positions into a more robust unified view. Acknowledge what remains unresolved. Stay within 100 words.';

export interface SynthesizerResult extends AgentResult {
  confidence: number;
}

/**
 * Parses a confidence value from text matching the pattern "confidence: 0.X".
 * Defaults to 0.5 if not found.
 */
function parseConfidence(text: string): number {
  const match = /confidence:\s*(0?\.\d+|1(?:\.0+)?|\d+(?:\.\d+)?)/i.exec(text);
  if (!match) return 0.5;
  const value = parseFloat(match[1]!);
  // Clamp to [0, 1].
  return Math.min(1, Math.max(0, value));
}

export class SynthesizerAgent implements Agent {
  readonly role = 'Synthesizer';
  readonly neurotype = 'integrative';

  constructor(private readonly adapter: ModelAdapter) {}

  async generate(blackboard: Blackboard): Promise<SynthesizerResult> {
    const recentTurns = blackboard.turns
      .slice(-6)
      .map((t) => `[${t.agent}]: ${t.content}`)
      .join('\n\n');

    const unresolvedConflicts = blackboard.conflicts
      .filter((c) => !c.resolved)
      .map((c) => `- ${c.between.join(' vs ')}: ${c.description}`)
      .join('\n');

    let userPrompt = `Topic: ${blackboard.topic}`;
    if (recentTurns.length > 0) {
      userPrompt += `\n\nDiscussion:\n\n${recentTurns}`;
    }
    if (unresolvedConflicts.length > 0) {
      userPrompt += `\n\nUnresolved conflicts:\n${unresolvedConflicts}`;
    }

    const raw = await this.adapter.generate(userPrompt, SYSTEM_PROMPT);
    const { content, truncated } = enforceWordCap(raw);
    const confidence = parseConfidence(raw);

    return { content, truncated, confidence };
  }
}
