import type { AdapterMeta, Blackboard, SynthesizerMeta, TurnMeta } from '../types.js';
import { AgentBase, type AgentResult } from './base.js';
import { buildPromptHeader, enforceWordCap } from './utils.js';

// PAR-40 — the memory-continuity clause is load-bearing. PAR-38 surfaces past
// decisions in `## Memory`; without explicit instruction the Synthesizer
// would either silently overwrite prior conclusions or treat them as
// constraints. The clause asks it to make the relationship explicit — the
// summary should say whether it's *consistent with* the prior decision or
// *overrides* it, so future recall renders the lineage rather than a
// disconnected sequence of summaries.
const SYSTEM_PROMPT = [
  'You are a synthesizer. Attempt to reconcile conflicting positions into a more robust',
  'unified view, acknowledging what remains unresolved.',
  '',
  'If the prompt header includes a `## Memory` section listing past decisions, your summary',
  'should make the relationship explicit — note whether the current synthesis is consistent',
  'with the prior decision, refines it, or overrides it (and why). Memory is context, not',
  'a constraint: a prior conclusion can be superseded if the current debate warrants it.',
  '',
  'You MUST output ONLY a single JSON object with no surrounding prose, no markdown fences,',
  'and no commentary. The JSON object MUST conform to this exact schema:',
  '',
  '{"summary": "<one-paragraph synthesis, max 200 words>", "confidence": <number in [0,1]>,',
  ' "consensus": <true|false>, "agreed": ["<short bullet, max 10 words>", ...],',
  ' "unresolved": ["<short bullet, max 10 words>", ...]}',
  '',
  'Field semantics:',
  '- summary: a single paragraph reconciling the debate so far. Plain prose only — no markdown.',
  '- confidence: your calibrated certainty in the synthesis, 0.0 (no confidence) to 1.0 (fully confident).',
  '- consensus: true ONLY if you judge the debate has genuinely resolved into a unified view; false otherwise.',
  '  Do not set true just because confidence is high.',
  '- agreed: short bullet strings (max ~10 words each) capturing the points the agents agree on.',
  '- unresolved: short bullet strings (max ~10 words each) capturing what remains unresolved.',
  '',
  'Output ONLY the JSON object. No preamble, no markdown, no trailing commentary.',
].join('\n');

const REINFORCEMENT = '\n\nOutput only the JSON object, no other text.';

/** Corrective re-prompt used after one parse failure. */
const RETRY_INSTRUCTION =
  "Your previous response wasn't valid JSON. Output ONLY the JSON object, nothing else.";

/** Cap on raw text included in the fail-closed summary so transcripts stay sane. */
const FAILSAFE_SUMMARY_WORDCAP = 60;

export interface SynthesizerResult extends AgentResult {
  /** Convenience field — mirrors `meta.confidence`. */
  confidence: number;
  /**
   * Structured signals; identical to what is attached to the recorded turn.
   * PAR-23 — also carries adapter telemetry (latency, tokens, cost,
   * provider) on the same record so the engine can persist the merged shape
   * onto `Turn.meta` without splitting the field.
   */
  meta: TurnMeta & SynthesizerMeta;
}

interface ParsedSynthesizerJson {
  summary: string;
  confidence: number;
  consensus: boolean;
  agreed: string[];
  unresolved: string[];
}

/**
 * Three-layer JSON extraction strategy. Why three: small open-weight models
 * routinely add a "Sure, here is the JSON:" preamble or wrap output in
 * ```json fences``` despite explicit instructions, so we (1) try a strict
 * parse, then (2) peel a fenced block, then (3) fall back to the first
 * balanced `{...}` substring.
 */
function extractJsonObject(raw: string): ParsedSynthesizerJson | null {
  // Layer 1: strict parse — works when the model obeys instructions exactly.
  const direct = tryParse(raw.trim());
  if (direct !== null) return direct;

  // Layer 2: fenced extraction — handles ```json {...} ``` wrappers.
  const fenceMatch = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/i.exec(raw);
  if (fenceMatch !== null) {
    const fenced = tryParse(fenceMatch[1]!);
    if (fenced !== null) return fenced;
  }

  // Layer 3: greedy brace match — handles "Sure, here is: { ... }" preambles.
  // Pick the first '{' and the *last* '}' so multi-line JSON survives.
  const firstBrace = raw.indexOf('{');
  const lastBrace = raw.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const slice = raw.slice(firstBrace, lastBrace + 1);
    const greedy = tryParse(slice);
    if (greedy !== null) return greedy;
  }

  return null;
}

function tryParse(text: string): ParsedSynthesizerJson | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return validateShape(parsed);
}

/**
 * Coerces a parsed JSON value into the canonical synthesizer shape. Tolerates
 * minor model-side drift (e.g. confidence as a string, missing arrays) by
 * normalising rather than rejecting — but anything fundamentally wrong (not
 * an object, no summary) returns null and triggers the retry path.
 */
function validateShape(value: unknown): ParsedSynthesizerJson | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;

  const summary = typeof obj['summary'] === 'string' ? obj['summary'] : null;
  if (summary === null || summary.length === 0) return null;

  const rawConf = obj['confidence'];
  let confidence: number;
  if (typeof rawConf === 'number' && Number.isFinite(rawConf)) {
    confidence = rawConf;
  } else if (typeof rawConf === 'string' && Number.isFinite(parseFloat(rawConf))) {
    confidence = parseFloat(rawConf);
  } else {
    return null;
  }
  // Clamp to [0, 1].
  confidence = Math.min(1, Math.max(0, confidence));

  const rawConsensus = obj['consensus'];
  if (typeof rawConsensus !== 'boolean') return null;

  const agreed = coerceStringArray(obj['agreed']);
  const unresolved = coerceStringArray(obj['unresolved']);

  return { summary, confidence, consensus: rawConsensus, agreed, unresolved };
}

function coerceStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * Builds a fail-closed result when both the initial generation and the retry
 * fail to parse. confidence=0 (NOT 0.5) and consensus=false ensure the engine
 * never terminates on a malformed synthesis; the raw text is truncated so the
 * transcript still shows what the model actually said.
 */
function failClosed(raw: string): ParsedSynthesizerJson {
  const { content } = enforceWordCap(raw, FAILSAFE_SUMMARY_WORDCAP);
  return {
    summary: content,
    confidence: 0,
    consensus: false,
    agreed: [],
    unresolved: [],
  };
}

export class SynthesizerAgent extends AgentBase {
  readonly role = 'Synthesizer';
  readonly neurotype = 'integrative';
  readonly posture = 'reconciliation';

  async generate(blackboard: Blackboard): Promise<SynthesizerResult> {
    const recentTurns = blackboard.turns
      .slice(-6)
      .map((t) => `[${t.agent}]: ${t.content}`)
      .join('\n\n');

    const unresolvedConflicts = blackboard.conflicts
      .filter((c) => !c.resolved)
      .map((c) => `- ${c.between.join(' vs ')}: ${c.description}`)
      .join('\n');

    let userPrompt = buildPromptHeader(
      blackboard.topic,
      blackboard.context,
      blackboard.sources,
      blackboard.memory,
    );
    if (recentTurns.length > 0) {
      userPrompt += `\n\nDiscussion:\n\n${recentTurns}`;
    }
    if (unresolvedConflicts.length > 0) {
      userPrompt += `\n\nUnresolved conflicts:\n${unresolvedConflicts}`;
    }
    userPrompt += REINFORCEMENT;

    // First attempt. PAR-25: failover-wrapped. A primary
    // ModelConnectionError is retried once on the fallback adapter (when
    // configured) BEFORE the synthesizer's own JSON-parse-retry path
    // engages — failover is a connection-layer concern; JSON-parse retry
    // is a content-layer concern, and the two compose without conflict.
    const raw = await this.generateWithFailover(userPrompt, SYSTEM_PROMPT);
    const parsed = extractJsonObject(raw.content);
    if (parsed !== null) {
      // PAR-23: thread the adapter's reported meta from the call that
      // produced the parsed structured output.
      return this.buildResult(parsed, raw.meta);
    }

    // One retry — embed the prior exchange into the user prompt so the model
    // has its own broken output to learn from. (ModelAdapter exposes a
    // single-prompt interface, so we splice the dialogue manually.)
    const retryPrompt = [
      userPrompt,
      '',
      '--- Your previous response ---',
      raw.content,
      '--- End previous response ---',
      '',
      RETRY_INSTRUCTION,
    ].join('\n');

    // PAR-25: the JSON-parse-retry call is also failover-wrapped — a
    // connection failure on the second adapter call deserves the same
    // treatment as the first.
    const retryRaw = await this.generateWithFailover(retryPrompt, SYSTEM_PROMPT);
    const retryParsed = extractJsonObject(retryRaw.content);
    if (retryParsed !== null) {
      // PAR-23: when the retry succeeds, attribute meta to the retry call
      // whose content actually became the synthesis. The first-attempt
      // latency / tokens are intentionally NOT summed in — turn-level meta
      // is a snapshot of the call that produced the persisted prose.
      return this.buildResult(retryParsed, retryRaw.meta);
    }

    // Both attempts failed — fail closed and warn. Match the existing
    // console-based logging used elsewhere in the package.
    console.warn(
      '[SynthesizerAgent] failed to parse JSON after 1 retry; falling back to fail-closed result',
      { firstAttemptLength: raw.content.length, retryLength: retryRaw.content.length },
    );
    return this.buildResult(failClosed(retryRaw.content), retryRaw.meta);
  }

  private buildResult(
    parsed: ParsedSynthesizerJson,
    adapterMeta: AdapterMeta | undefined,
  ): SynthesizerResult {
    // The blackboard stays human-readable: `content` is the prose summary,
    // and the structured signals live on `meta`. PAR-23: adapter telemetry
    // (latency, tokens, cost, provider) is merged in alongside the
    // synthesizer's own structured fields so the engine can persist the
    // combined shape onto Turn.meta in a single write.
    const { content, truncated } = enforceWordCap(parsed.summary);
    const synthFields: SynthesizerMeta = {
      confidence: parsed.confidence,
      consensus: parsed.consensus,
      agreed: parsed.agreed,
      unresolved: parsed.unresolved,
    };
    const meta: TurnMeta & SynthesizerMeta = {
      ...(adapterMeta ?? {}),
      ...synthFields,
    };
    return { content, truncated, confidence: parsed.confidence, meta };
  }
}
