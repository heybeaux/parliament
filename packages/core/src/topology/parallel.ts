/**
 * ----------------------------------------------------------------------------
 * Parallel-step executor (Stage 4 — add-jury-parallel)
 * ----------------------------------------------------------------------------
 *
 * Runs a `parallel_steps` block declared on a topology preset. Behaviour
 * pinned by `openspec/changes/add-jury-parallel/specs/topology-parallel/
 * spec.md` and the elaboration decisions on task 6483cac1:
 *
 *   1. Read-only snapshot of the blackboard captured at block start; every
 *      sibling reads from the same snapshot. Siblings never see each other's
 *      mid-block output.
 *   2. Strict happens-before — all prior step persistence is complete by the
 *      time the snapshot is taken (the caller owns this; the executor is
 *      called only after sequential steps return).
 *   3. Concurrent execution via `Promise.allSettled`-style semantics, BUT
 *      governed by a single block-level timeout that aborts the whole block
 *      if any sibling exceeds it.
 *   4. Registration-order merge: results are appended to the live blackboard
 *      in the order the steps appear in `parallel_steps`, NOT the order in
 *      which agents finished.
 *   5. Every produced turn is annotated with a `parallel_group` field — a
 *      random UUID generated once per block invocation.
 * ----------------------------------------------------------------------------
 */

import { randomUUID } from 'node:crypto';
import type { Agent } from '../agents/base.js';
import type { AdapterMeta, Blackboard, Conflict, Turn } from '../types.js';
import type {
  NeurotypeResolver,
  NeurotypeResolverContext,
  TopologyRuntimeLogger,
} from '../engine.js';
import type { TopologyStep } from './types.js';

/** Result of executing a parallel block. The caller appends these in order. */
export interface ParallelBlockResult {
  /** Turns produced by siblings, in registration order. */
  turns: Turn[];
  /** New conflicts produced by siblings (e.g. Skeptic), in registration order. */
  conflicts: Conflict[];
  /** UUID assigned to this block; shared by every sibling turn. */
  parallelGroup: string;
}

export interface ExecuteParallelBlockOptions {
  /**
   * Per-block timeout in milliseconds. When any sibling exceeds this, the
   * returned promise rejects with a `ParallelBlockTimeoutError` naming the
   * slow agent. `undefined` disables the timeout (used by tests that don't
   * exercise the timeout path).
   */
  timeoutMs?: number;
  /** Optional logger for completion-timing debug output. */
  logger?: TopologyRuntimeLogger;
  /**
   * PAR-10: synthesizer-confidence-by-round map captured by the engine.
   * Used to compute each sibling's `convergence_delta` so parallel turns
   * carry the same enrichment as sequential ones. Optional for back-compat
   * with existing tests that don't exercise the field.
   */
  synthConfidenceByRound?: ReadonlyMap<number, number>;
  /**
   * PAR-25 — opaque resolver context the engine passes through to the
   * caller-supplied `NeurotypeResolver`. Carries the engine's
   * `provider.failover` event push fn so siblings constructed inside the
   * parallel block share the same observability wire as sequential steps.
   * Optional / additive — parallel-only tests that don't exercise failover
   * pass nothing and behaviour is unchanged.
   */
  resolverContext?: NeurotypeResolverContext;
}

/**
 * Error thrown when one or more parallel-block siblings fail to produce a
 * result within the block-level timeout. Carries a stable `code` so callers
 * can distinguish timeout aborts from generic agent errors.
 */
export class ParallelBlockTimeoutError extends Error {
  readonly code = 'parallel_block_timeout';
  /** Step IDs of the agents that exceeded the timeout. */
  readonly slowSteps: readonly string[];
  constructor(slowSteps: readonly string[], timeoutMs: number) {
    const list = slowSteps.map((s) => `"${s}"`).join(', ');
    super(
      `Parliament: parallel block exceeded ${timeoutMs}ms timeout — slow agent(s): ${list}`,
    );
    this.name = 'ParallelBlockTimeoutError';
    this.slowSteps = Object.freeze([...slowSteps]);
  }
}

/**
 * Builds a deep-clone snapshot of the blackboard. The clone shares no array
 * or object references with the original, so any agent that mutates its
 * snapshot (notably Skeptic, which pushes onto `blackboard.conflicts`) cannot
 * affect siblings or the live blackboard.
 *
 * We use `structuredClone` rather than JSON-roundtripping so that Date-like
 * values (none currently, but future-proofing) and `undefined` slots survive.
 */
function snapshotBlackboard(blackboard: Blackboard): Blackboard {
  return {
    topic: blackboard.topic,
    turns: structuredClone(blackboard.turns),
    conflicts: structuredClone(blackboard.conflicts),
    metadata: structuredClone(blackboard.metadata),
  };
}

/**
 * Counts whitespace-delimited words. Mirrors `engine.ts#countWords` so the
 * `word_count` field on a parallel turn matches the convention used by the
 * sequential path (load-bearing for the Stage 3 Timeline UI).
 */
function countWords(content: string): number {
  const trimmed = content.trim();
  if (trimmed.length === 0) return 0;
  return trimmed.split(/\s+/).length;
}

/**
 * PAR-10: per-turn convergence delta, identical semantics to the function of
 * the same name in `engine.ts`. Duplicated here rather than imported because
 * `parallel.ts` is consumed by the engine module — making engine.ts depend on
 * parallel.ts AND parallel.ts depend on engine.ts would cycle. Returns 0
 * (the explicit "not measurable" sentinel) when no map is provided.
 */
function computeConvergenceDeltaForRound(
  round: number,
  synthByRound: ReadonlyMap<number, number> | undefined,
): number {
  if (synthByRound === undefined) return 0;
  if (round <= 1) return 0;
  const prior = synthByRound.get(round - 1);
  if (prior === undefined) return 0;
  const before = synthByRound.get(round - 2) ?? 0;
  return Number((prior - before).toFixed(4));
}

/**
 * Wraps a sibling agent's `generate` call so the block can attribute timeouts
 * and unexpected errors back to a specific step ID. Returns the agent's
 * `AgentResult` plus the resolved `Agent` (used to pull `role`, `neurotype`,
 * `modelName` for the recorded turn) and elapsed time (for debug logging).
 */
async function runSibling(
  step: TopologyStep,
  snapshot: Blackboard,
  resolveNeurotype: NeurotypeResolver,
  resolverContext: NeurotypeResolverContext | undefined,
): Promise<{
  step: TopologyStep;
  agent: Agent;
  content: string;
  /** PAR-23 — adapter telemetry for this sibling, when reported. */
  meta?: AdapterMeta;
  elapsedMs: number;
  conflicts: Conflict[];
}> {
  // Each sibling gets its OWN clone of the snapshot so any mutation it makes
  // (e.g. Skeptic pushing to `conflicts`) is isolated. The outer snapshot is
  // shared only by reference for read-only fields like `topic` — we still
  // re-clone here to keep the invariant unconditional.
  const ownView = snapshotBlackboard(snapshot);
  const startedAt = Date.now();
  // PAR-25: forward the resolver context (carrying the engine's
  // `provider.failover` push fn) so siblings constructed inside the block
  // see the same wiring as sequential steps. Resolvers that ignore the
  // second arg behave exactly as before.
  const agent = resolveNeurotype(step, resolverContext);
  const result = await agent.generate(ownView);
  const elapsedMs = Date.now() - startedAt;

  // Capture any conflicts the agent appended. We compare lengths against the
  // input snapshot, not `ownView` post-call, to be defensive against agents
  // that might re-order conflicts (none currently do).
  const newConflicts = ownView.conflicts.slice(snapshot.conflicts.length);

  // PAR-23: forward the adapter telemetry from `result.meta` so the parallel
  // executor can stamp it onto the sibling's recorded Turn — same shape as
  // the sequential path's `recordTurn(..., result.meta)` call.
  return {
    step,
    agent,
    content: result.content,
    ...(result.meta !== undefined ? { meta: result.meta } : {}),
    elapsedMs,
    conflicts: newConflicts,
  };
}

/**
 * Executes a parallel block.
 *
 * Concurrency model: spawn every sibling at once. Race the joined `Promise.all`
 * against an optional timeout `setTimeout`. On timeout, identify which
 * siblings haven't resolved yet and throw `ParallelBlockTimeoutError`; the
 * caller is expected to abort the whole deliberation (per spec — partial
 * results are NEVER committed to the live blackboard).
 *
 * On success, results are sorted into registration order (the order of `steps`
 * in the input array) before being returned, regardless of completion order.
 */
export async function executeParallelBlock(
  steps: readonly TopologyStep[],
  blackboard: Blackboard,
  resolveNeurotype: NeurotypeResolver,
  round: number,
  options: ExecuteParallelBlockOptions = {},
): Promise<ParallelBlockResult> {
  const { timeoutMs, logger, synthConfidenceByRound, resolverContext } = options;
  const parallelGroup = randomUUID();

  if (steps.length === 0) {
    return { turns: [], conflicts: [], parallelGroup };
  }

  // Capture the snapshot ONCE up front. All siblings read from it; none
  // observe each other's outputs.
  const snapshot = snapshotBlackboard(blackboard);

  // Track per-step settlement so that on timeout we can name the offenders.
  const settled = new Set<string>();
  const tasks = steps.map((step) =>
    runSibling(step, snapshot, resolveNeurotype, resolverContext).then(
      (res) => {
        settled.add(step.id);
        return { kind: 'ok' as const, value: res };
      },
      (err: unknown) => {
        settled.add(step.id);
        return { kind: 'err' as const, step, error: err };
      },
    ),
  );

  const allTasks = Promise.all(tasks);

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeoutPromise: Promise<never> | null =
    timeoutMs === undefined
      ? null
      : new Promise<never>((_resolve, reject) => {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            const slow = steps.filter((s) => !settled.has(s.id)).map((s) => s.id);
            reject(new ParallelBlockTimeoutError(slow, timeoutMs));
          }, timeoutMs);
        });

  let outcomes: Array<{ kind: 'ok'; value: Awaited<ReturnType<typeof runSibling>> } | { kind: 'err'; step: TopologyStep; error: unknown }>;
  try {
    outcomes = await (timeoutPromise === null
      ? allTasks
      : Promise.race([allTasks, timeoutPromise]));
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }

  // If we bailed via timeout, the race threw above; this guard is defensive.
  if (timedOut) {
    const slow = steps.filter((s) => !settled.has(s.id)).map((s) => s.id);
    throw new ParallelBlockTimeoutError(slow, timeoutMs!);
  }

  // Surface any agent errors that aren't timeouts. We propagate the FIRST
  // failure in registration order to keep error messages deterministic.
  for (let i = 0; i < outcomes.length; i++) {
    const o = outcomes[i]!;
    if (o.kind === 'err') {
      const stepId = o.step.id;
      const cause = o.error instanceof Error ? o.error.message : String(o.error);
      throw new Error(
        `Parliament: parallel sibling "${stepId}" failed: ${cause}`,
      );
    }
  }

  // Registration-order merge. `outcomes` is already in registration order
  // because `tasks` was built from `steps` in order and `Promise.all`
  // preserves position; we map to turns/conflicts here.
  const turns: Turn[] = [];
  const conflicts: Conflict[] = [];

  // PAR-10: convergence_delta is the same for every sibling in this block —
  // it depends only on the round and the engine-supplied synth-confidence
  // map. Compute once outside the loop.
  const convergenceDelta = computeConvergenceDeltaForRound(round, synthConfidenceByRound);

  for (let i = 0; i < outcomes.length; i++) {
    const o = outcomes[i] as { kind: 'ok'; value: Awaited<ReturnType<typeof runSibling>> };
    const { step, agent, content, meta, elapsedMs, conflicts: stepConflicts } = o.value;
    // PAR-10: posture defaults to neurotype id when the agent doesn't
    // declare one (kept consistent with `recordTurn` in engine.ts).
    const posture =
      'posture' in agent && typeof agent.posture === 'string'
        ? agent.posture
        : agent.neurotype;
    const turn: Turn = {
      agent: agent.role,
      neurotype: agent.neurotype,
      model: agent.modelName,
      content,
      timestamp: new Date().toISOString(),
      round,
      word_count: countWords(content),
      parallel_group: parallelGroup,
      model_name: agent.modelName,
      neurotype_posture: posture,
      convergence_delta: convergenceDelta,
    };
    // PAR-23: stamp adapter telemetry onto the sibling turn — same shape as
    // the sequential `recordTurn` path so parallel transcripts carry the
    // same observability signal.
    if (meta !== undefined) {
      turn.meta = meta;
    }
    turns.push(turn);
    conflicts.push(...stepConflicts);
    if (logger !== undefined) {
      logger.info(
        `topology: parallel sibling "${step.id}" (neurotype "${step.neurotype}") completed in ${elapsedMs}ms`,
      );
    }
  }

  return { turns, conflicts, parallelGroup };
}
