import type { Agent } from '../agents/base.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScheduledTurn {
  role: string;
  /** Model identifier, e.g. "llama3.2", "mistral". */
  model: string;
  agent: Agent;
  /** Roles that must complete before this turn can run. */
  dependsOn: string[];
}

export interface BatchSchedule {
  /**
   * Each inner array is a batch of turns that share the same model and whose
   * dependencies are all satisfied before the batch runs.  Turns within a
   * batch are ordered but logically grouped so the model need not be
   * unloaded between them.
   */
  batches: ScheduledTurn[][];
}

// ---------------------------------------------------------------------------
// Level-based topological sort
// ---------------------------------------------------------------------------

/**
 * Computes the dependency "level" for each role using BFS (Kahn's algorithm).
 * Returns a map from role → level, where level 0 means no dependencies.
 */
function computeLevels(turns: ScheduledTurn[]): Map<string, number> {
  const byRole = new Map<string, ScheduledTurn>(turns.map((t) => [t.role, t]));
  const levels = new Map<string, number>(turns.map((t) => [t.role, 0]));

  // Build in-degree and adjacency based only on roles present in the set.
  const indegree = new Map<string, number>(turns.map((t) => [t.role, 0]));

  for (const turn of turns) {
    for (const dep of turn.dependsOn) {
      if (byRole.has(dep)) {
        indegree.set(turn.role, (indegree.get(turn.role) ?? 0) + 1);
      }
    }
  }

  // Queue starts with all zero-indegree nodes.
  const queue: string[] = [];
  for (const [role, deg] of indegree) {
    if (deg === 0) queue.push(role);
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    const currentLevel = levels.get(current) ?? 0;

    // Update levels for dependents of `current`.
    for (const turn of turns) {
      if (!turn.dependsOn.includes(current)) continue;
      // Only consider deps that are in our set.
      const newLevel = Math.max(levels.get(turn.role) ?? 0, currentLevel + 1);
      levels.set(turn.role, newLevel);

      indegree.set(turn.role, (indegree.get(turn.role) ?? 1) - 1);
      if (indegree.get(turn.role) === 0) {
        queue.push(turn.role);
      }
    }
  }

  // Detect cycles: any node still with indegree > 0 is in a cycle.
  for (const [role, deg] of indegree) {
    if (deg > 0) {
      throw new Error(`Circular dependency detected involving role "${role}"`);
    }
  }

  return levels;
}

/**
 * Group turns by their dependency level, order within each level to maximise
 * model affinity (same model grouped together), then emit a flat ordered list.
 *
 * Within each level, turns are sorted by model so same-model agents are
 * adjacent.  The ordering is stable relative to the model adjacency of the
 * *previous* level's last model — this minimises the number of swaps between
 * levels as well.
 */
function levelSort(turns: ScheduledTurn[]): ScheduledTurn[] {
  const levels = computeLevels(turns);

  // Group by level.
  const byLevel = new Map<number, ScheduledTurn[]>();
  for (const turn of turns) {
    const lv = levels.get(turn.role) ?? 0;
    if (!byLevel.has(lv)) byLevel.set(lv, []);
    byLevel.get(lv)!.push(turn);
  }

  const sortedLevels = [...byLevel.keys()].sort((a, b) => a - b);
  const result: ScheduledTurn[] = [];
  let prevModel: string | null = null;

  for (const lv of sortedLevels) {
    const group = byLevel.get(lv)!;

    // Collect distinct models in this level, preferring the previous level's
    // last model first to avoid an unnecessary swap at the boundary.
    const modelOrder: string[] = [];
    if (prevModel !== null && group.some((t) => t.model === prevModel)) {
      modelOrder.push(prevModel);
    }
    for (const turn of group) {
      if (!modelOrder.includes(turn.model)) modelOrder.push(turn.model);
    }

    // Emit turns grouped by model according to modelOrder.
    for (const model of modelOrder) {
      const subset = group.filter((t) => t.model === model);
      result.push(...subset);
    }

    prevModel = result[result.length - 1]?.model ?? null;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a schedule that maximises model reuse while preserving dependency
 * ordering.
 *
 * Algorithm:
 *   1. Assign each turn a dependency "level" (0 = no deps).
 *   2. Within each level, sort turns to group same-model agents together,
 *      preferring the model used at the end of the previous level to avoid
 *      unnecessary swaps at level boundaries.
 *   3. Group consecutive same-model turns in the resulting flat sequence into
 *      batches.
 */
export function buildBatchSchedule(agents: ScheduledTurn[]): BatchSchedule {
  if (agents.length === 0) return { batches: [] };

  const sorted = levelSort(agents);

  // Group consecutive same-model turns into batches.
  const batches: ScheduledTurn[][] = [];
  let currentBatch: ScheduledTurn[] = [sorted[0]!];

  for (let i = 1; i < sorted.length; i++) {
    const turn = sorted[i]!;
    if (turn.model === currentBatch[0]!.model) {
      currentBatch.push(turn);
    } else {
      batches.push(currentBatch);
      currentBatch = [turn];
    }
  }
  batches.push(currentBatch);

  return { batches };
}

/**
 * Count the number of model swaps in a flat (sequential) turn sequence.
 * A swap occurs every time consecutive turns use different models.
 */
export function countModelSwaps(turns: ScheduledTurn[]): number {
  if (turns.length <= 1) return 0;

  let swaps = 0;
  for (let i = 1; i < turns.length; i++) {
    if (turns[i]!.model !== turns[i - 1]!.model) {
      swaps++;
    }
  }
  return swaps;
}
