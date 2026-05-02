import type { Blackboard } from '../types.js';
import { AgentBase, type AgentResult } from './base.js';
import { buildPromptHeader, capWithMeta } from './utils.js';

export const EMPIRICIST_SYSTEM_PROMPT =
  'You are the Empiricist. Your posture is evidence-first: distinguish empirical claims (testable against the world) from value-judgment claims (not testable). ' +
  'For each empirical claim made by another agent that lacks evidence, demand specific evidence using the literal phrase "demand evidence" — name what data, study, or measurement would settle the question. ' +
  'For each value-judgment claim, label it explicitly with the literal sentence "this claim is a value judgment, not an empirical one." ' +
  'Do NOT reject value-judgment claims and do NOT treat them as out-of-scope; ethics and policy deliberations depend on them remaining in the transcript. Flag the limitation, then move on. ' +
  'Stay within 200 words. Output plain prose only — no markdown headers, bold, italics, or bullet lists.';

/**
 * PAR-17 — additional line prepended to the Empiricist's system prompt when
 * `blackboard.sources` is non-empty. Activates "Evidence-backed claim mode":
 * the agent is instructed to prefer pulling evidence directly from the
 * supplied `## Sources` block (citing each by its `[id]`) before issuing a
 * "demand evidence" call. The standing posture (distinguish empirical from
 * value-judgment claims, stay within 200 words, plain prose) is otherwise
 * unchanged — this is a single-line activation, not a rewrite.
 */
export const EMPIRICIST_SOURCES_MODE_PREFIX =
  'Evidence-backed claim mode: structured sources are attached. When an empirical claim has support in those sources, cite the relevant source id in `[brackets]` rather than issuing a "demand evidence" call; reserve "demand evidence" for empirical claims the supplied sources do NOT cover.';

export class EmpiricistAgent extends AgentBase {
  readonly role = 'Empiricist';
  readonly neurotype = 'empiricist';
  readonly posture = 'evidence-first';

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

    // PAR-17: when structured sources are attached, activate evidence-backed
    // claim mode by prepending the single activation line to the standing
    // system prompt. The prepended line ends with `\n\n` so the activation
    // and the standing posture are visually delimited.
    const hasSources =
      blackboard.sources !== undefined && blackboard.sources.length > 0;
    const systemPrompt = hasSources
      ? `${EMPIRICIST_SOURCES_MODE_PREFIX}\n\n${EMPIRICIST_SYSTEM_PROMPT}`
      : EMPIRICIST_SYSTEM_PROMPT;

    // PAR-23: forward adapter telemetry onto the returned AgentResult.
    // PAR-25: failover-wrapped call.
    const raw = await this.generateWithFailover(userPrompt, systemPrompt);
    return capWithMeta(raw);
  }
}
