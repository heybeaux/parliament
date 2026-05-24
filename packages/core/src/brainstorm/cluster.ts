/**
 * Cluster phase for brainstorm mode (Section 6).
 *
 * Takes the deduped survivors and groups them into thematic clusters via a
 * single model call (Opus 4.6 by default — see `defaultBrainstormLineup`).
 * Cluster output is ADVISORY: labels are surfaced to the UI and may be passed
 * to the rank phase as context, but they do not affect scoring directly and
 * MUST NOT abort the run on failure.
 *
 * Soft-fail contract: if the model call throws, or the parse + one-shot retry
 * both fail, the phase returns ideas unchanged with `cluster: null` on each,
 * a warning on the phase record, and an empty `cluster_map`. The caller
 * (orchestrator) continues to rank.
 *
 * This differs from divergent.ts's "preserve as unstructured prose" fallback:
 * cluster output is not identity-bearing, so we drop it entirely rather than
 * fabricate per-idea labels from raw text.
 *
 * Spec: `openspec/changes/add-brainstorm-mode/tasks.md` Section 6.
 */

import type { BrainstormIdea, BrainstormPhaseRecord } from './types.js';
import type { AdapterFactory } from './orchestrator.js';
import { clusterPrompt, CLUSTER_RETRY_INSTRUCTION } from './prompts.js';

export interface RunClusterPhaseInput {
  prompt: string;
  ideas: readonly BrainstormIdea[];
  /** Model that performs clustering. From `BrainstormLineup.cluster.model`. */
  clusterModel: string;
  factory: AdapterFactory;
}

export interface ClusterPhaseOutput {
  /**
   * Ideas with `cluster` populated. On soft-fail every idea has `cluster: null`.
   * Order matches the input order so downstream consumers can rely on stable
   * ordering across phases.
   */
  ideas: BrainstormIdea[];
  warnings: string[];
  phaseRecord: BrainstormPhaseRecord;
}

interface RawCluster {
  label?: unknown;
  idea_ids?: unknown;
}

function tryParseClusters(raw: string): RawCluster[] | null {
  const strict = tryParse(raw.trim());
  if (strict !== null) return strict;

  const fence = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fence !== null && typeof fence[1] === 'string') {
    const fenced = tryParse(fence[1].trim());
    if (fenced !== null) return fenced;
  }

  const firstOpen = raw.indexOf('{');
  if (firstOpen === -1) return null;
  let depth = 0;
  for (let i = firstOpen; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const candidate = raw.slice(firstOpen, i + 1);
        const balanced = tryParse(candidate);
        if (balanced !== null) return balanced;
      }
    }
  }
  return null;
}

function tryParse(text: string): RawCluster[] | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;
    if (!Array.isArray(obj['clusters'])) return null;
    return obj['clusters'] as RawCluster[];
  } catch {
    return null;
  }
}

/**
 * Validate cluster output and project it onto the input ideas. Returns null
 * if structurally invalid (caller then soft-fails). A cluster is invalid if:
 * - any cluster has a non-string or empty label
 * - any idea_ids entry is not a string
 * - any referenced idea_id is unknown
 * - any input idea_id is unassigned (orphan)
 * - any idea_id is assigned to more than one cluster (duplicate)
 */
function buildClusterMap(
  raw: RawCluster[],
  inputIds: readonly string[],
): { map: Record<string, string[]>; assignment: Map<string, string> } | null {
  const map: Record<string, string[]> = {};
  const assignment = new Map<string, string>();
  const inputIdSet = new Set(inputIds);

  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) return null;
    const label = entry.label;
    const ideaIds = entry.idea_ids;
    if (typeof label !== 'string' || label.trim() === '') return null;
    if (!Array.isArray(ideaIds)) return null;
    const trimmedLabel = label.trim();

    const collected: string[] = [];
    for (const id of ideaIds) {
      if (typeof id !== 'string' || id.trim() === '') return null;
      if (!inputIdSet.has(id)) return null;
      if (assignment.has(id)) return null; // duplicate assignment
      assignment.set(id, trimmedLabel);
      collected.push(id);
    }

    // Multiple cluster entries with the same label are merged.
    if (map[trimmedLabel] === undefined) {
      map[trimmedLabel] = collected;
    } else {
      map[trimmedLabel].push(...collected);
    }
  }

  // Every input idea must be assigned.
  for (const id of inputIds) {
    if (!assignment.has(id)) return null;
  }

  return { map, assignment };
}

function nullClusterIdeas(ideas: readonly BrainstormIdea[]): BrainstormIdea[] {
  return ideas.map((idea) => ({ ...idea, cluster: null }));
}

function softFailOutput(
  ideas: readonly BrainstormIdea[],
  warning: string,
): ClusterPhaseOutput {
  const nulled = nullClusterIdeas(ideas);
  const warnings = [warning];
  return {
    ideas: nulled,
    warnings,
    phaseRecord: {
      phase: 'idea-cluster',
      ideas: nulled,
      cluster_map: {},
      warnings,
    },
  };
}

export async function runClusterPhase({
  prompt,
  ideas,
  clusterModel,
  factory,
}: RunClusterPhaseInput): Promise<ClusterPhaseOutput> {
  // Empty input — nothing to cluster. Not a failure, just a no-op.
  if (ideas.length === 0) {
    return {
      ideas: [],
      warnings: [],
      phaseRecord: {
        phase: 'idea-cluster',
        ideas: [],
        cluster_map: {},
      },
    };
  }

  // Only structured ideas with non-empty titles are passed to the clusterer.
  // Unstructured ideas (parse-failure survivors) carry no semantic label that
  // the clusterer could meaningfully group on; they always get cluster=null.
  const clusterable = ideas.filter(
    (i) => i.unstructured !== true && i.title.trim() !== '',
  );

  // If nothing is clusterable, return all ideas with cluster=null (no warning —
  // this is structurally inevitable, not a failure).
  if (clusterable.length === 0) {
    const nulled = nullClusterIdeas(ideas);
    return {
      ideas: nulled,
      warnings: [],
      phaseRecord: {
        phase: 'idea-cluster',
        ideas: nulled,
        cluster_map: {},
      },
    };
  }

  const { system, user } = clusterPrompt({ prompt, ideas: clusterable });

  let raw: RawCluster[] | null = null;
  let firstContent = '';

  try {
    const adapter = factory(clusterModel);
    const first = await adapter.generate(user, system);
    firstContent = first.content;
    raw = tryParseClusters(first.content);

    if (raw === null) {
      const retry = await adapter.generate(
        `${CLUSTER_RETRY_INSTRUCTION}\n\nOriginal prompt:\n${user}\n\nYour previous response:\n${first.content}`,
        system,
      );
      raw = tryParseClusters(retry.content);
      if (raw === null) {
        return softFailOutput(
          ideas,
          `idea-cluster: clusterer ${clusterModel} returned unparseable JSON after retry; proceeding with cluster=null.`,
        );
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return softFailOutput(
      ideas,
      `idea-cluster: clusterer ${clusterModel} call failed (${message}); proceeding with cluster=null.`,
    );
  }

  const clusterableIds = clusterable.map((i) => i.idea_id);
  const built = buildClusterMap(raw, clusterableIds);
  if (built === null) {
    return softFailOutput(
      ideas,
      `idea-cluster: clusterer ${clusterModel} returned structurally invalid clusters (orphans, duplicates, or unknown ids); proceeding with cluster=null. raw=${firstContent.slice(0, 200)}`,
    );
  }

  // Project assignments back onto the full input set (preserving original
  // order). Unstructured / unclusterable ideas get cluster=null.
  const out: BrainstormIdea[] = ideas.map((idea) => {
    const label = built.assignment.get(idea.idea_id);
    return { ...idea, cluster: label ?? null };
  });

  // Freeze inner arrays for the phase record.
  const frozenMap: Record<string, readonly string[]> = {};
  for (const [k, v] of Object.entries(built.map)) {
    frozenMap[k] = v;
  }

  return {
    ideas: out,
    warnings: [],
    phaseRecord: {
      phase: 'idea-cluster',
      ideas: out,
      cluster_map: frozenMap,
    },
  };
}
