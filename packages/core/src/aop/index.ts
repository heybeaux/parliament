/**
 * AOP (Agent Observation Protocol) v0.1 projection for Parliament.
 *
 * Projects a completed `DeliberationResult` into a language-neutral AOP
 * "reasoning" observation conforming to the published v0.1 envelope schema
 * (source of truth: heybeaux/sonder `aop/schema/v0.1`; a copy is vendored
 * alongside this file as `agent-observation-event.schema.v0.1.json` and kept
 * in sync).
 *
 * Deliberately self-contained: this module imports NOTHING from Sonder. That
 * is the whole point of AOP's spec/impl split — a non-Sonder runtime
 * (Parliament) emits a conformant cognitive observation without depending on
 * the reference implementation. The AOP shapes below are the spec's, declared
 * locally so Parliament owns no runtime coupling to Sonder.
 */

import type { DeliberationResult, Turn } from '../types.js';

/** AOP spec version this projection targets. */
export const AOP_VERSION = '0.1' as const;

/** AOP `reasoning` block — THINKS faculty. Mirrors the v0.1 schema $defs.reasoning. */
export interface AopReasoning {
  /** Participating model(s). Multi-model debates have no single model, so this
   *  is a `+`-joined unique list (e.g. "claude-opus+gpt-4o"), matching the
   *  convention AOP governance uses for `tier`. */
  model: string;
  /** Unique neurotypes that spoke, in first-seen order. */
  neurotypes: string[];
  /** True iff the deliberation terminated by reaching consensus. */
  consensus: boolean;
  /** Unresolved positions: dissenting agents on a split, plus the last
   *  synthesizer's unresolved bullets. Empty when consensus was reached. */
  dissent: string[];
  /** Opinion-spread index in [0,1]. Parliament never populates per-turn
   *  Jaccard OSI on completed results, so this is the engine's real end-of-run
   *  disagreement signal — `residueScore` (weighted fraction of unresolved
   *  conflicts). 0 = full agreement, 1 = maximally split. */
  osi: number;
  /** Number of deliberation rounds executed before termination. */
  rounds: number;
}

/** OTel interop block — links a cognitive event to its execution span. */
export interface AopTraceContext {
  trace_id?: string;
  span_id?: string;
}

/**
 * AOP v0.1 envelope carrying a Parliament reasoning observation. Only the
 * five identity fields plus `reasoning` are produced here (the "reasoning"
 * conformance tier); other cognitive blocks are absent by design.
 */
export interface AopReasoningObservation {
  aop_version: typeof AOP_VERSION;
  id: string;
  agent_id: string;
  task_id: string;
  parent_id?: string;
  timestamp: string;
  trace_context?: AopTraceContext;
  reasoning: AopReasoning;
  metadata?: Record<string, unknown>;
}

export interface ToAopReasoningOptions {
  /** AOP envelope id. Defaults to a `delib:`-prefixed synthetic id when the
   *  caller has no event id to supply. */
  id?: string;
  /** Agent that ran the deliberation (the Parliament instance / caller). */
  agent_id?: string;
  /** Task this deliberation served. Defaults to the deliberation topic. */
  task_id?: string;
  /** Predecessor event id, when chaining into a larger trace. */
  parent_id?: string;
  /** OTel trace/span linkage. Parliament does not own these; the caller (a
   *  runtime with an execution tracer) supplies them. */
  trace_context?: AopTraceContext;
}

const SYNTHESIZER_AGENT = 'synthesizer';

/** Unique values preserving first-seen order. */
function uniqueInOrder(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (v && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

/** The last synthesizer turn carries the end-of-run agreed/unresolved bullets. */
function lastSynthesizerTurn(turns: readonly Turn[]): Turn | undefined {
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (t && t.agent.toLowerCase() === SYNTHESIZER_AGENT) return t;
  }
  return undefined;
}

/**
 * Derive the AOP `reasoning` block from a completed deliberation.
 *
 * Pure: never throws on a well-formed result, never mutates the input.
 * Models/neurotypes are scanned from the transcript (Parliament stores no
 * explicit lineup on the result); consensus comes from `terminationReason`;
 * `osi` is the engine's `residueScore`; dissent is the union of split agents
 * and the synthesizer's unresolved bullets.
 */
export function deriveReasoning(result: DeliberationResult): AopReasoning {
  const turns = result.turns ?? [];

  // Exclude the synthesizer from "participating models/neurotypes" — it is a
  // structural coordinator, not a debating voice.
  const debaterTurns = turns.filter((t) => t.agent.toLowerCase() !== SYNTHESIZER_AGENT);
  const models = uniqueInOrder(debaterTurns.map((t) => t.model));
  const neurotypes = uniqueInOrder(debaterTurns.map((t) => t.neurotype));

  const consensus = result.terminationReason === 'consensus';

  const dissent: string[] = [];
  if (result.split) {
    // Agents holding distinct positions on a non-consensus split.
    for (const agent of Object.keys(result.split.positions)) {
      if (agent.toLowerCase() !== SYNTHESIZER_AGENT) dissent.push(agent);
    }
  }
  if (!consensus) {
    const synth = lastSynthesizerTurn(turns);
    const unresolved = synth?.meta?.unresolved ?? [];
    for (const point of unresolved) dissent.push(point);
  }

  const osi = clamp01(result.residueScore);

  return {
    model: models.join('+'),
    neurotypes,
    consensus,
    dissent,
    osi,
    rounds: result.totalRounds,
  };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * Project a completed `DeliberationResult` into an AOP v0.1 reasoning
 * observation. This is the concrete answer to "can Parliament's reasoning be
 * read as AOP?": yes — this is the read, and it imports nothing from Sonder.
 */
export function toAopReasoningObservation(
  result: DeliberationResult,
  options: ToAopReasoningOptions = {},
): AopReasoningObservation {
  const reasoning = deriveReasoning(result);

  const obs: AopReasoningObservation = {
    aop_version: AOP_VERSION,
    id: options.id ?? `delib:${result.started_at}:${result.topic}`,
    agent_id: options.agent_id ?? 'parliament',
    task_id: options.task_id ?? result.topic,
    timestamp: result.completed_at,
    reasoning,
  };

  if (options.parent_id !== undefined) obs.parent_id = options.parent_id;
  if (options.trace_context !== undefined) obs.trace_context = options.trace_context;

  // Carry Parliament-specific provenance that is NOT part of the AOP reasoning
  // contract under `metadata` (preset, termination reason, raw residue), so a
  // pure-AOP consumer ignores it but a Parliament consumer can recover it.
  const metadata: Record<string, unknown> = {
    parliament: {
      termination_reason: result.terminationReason,
      residue_score: result.residueScore,
      ...(result.preset !== undefined ? { preset: result.preset } : {}),
    },
  };
  obs.metadata = metadata;

  return obs;
}
