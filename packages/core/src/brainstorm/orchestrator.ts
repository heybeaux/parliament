/**
 * Brainstorm orchestrator — entry point for the brainstorm reasoning
 * pattern. Pipeline:
 *
 *   divergent-generation → idea-dedupe → idea-cluster → idea-rank
 *                                                       → [forge-elaboration]
 *
 * Spec: `openspec/changes/add-brainstorm-mode/specs/brainstorm-mode/spec.md`.
 *
 * ARCHITECTURAL LOCK: this orchestrator MUST NOT import `runIdeation` from
 * `../ideate/orchestrator`. Brainstorm is a distinct runtime — aliasing the
 * routes over ideate is the bug this change exists to fix (see
 * `docs/2026-05-23-rook-handover-brainstorm-forge-training-pattern.md`).
 *
 * Intentional reuse: `runDedupePhase` from `../ideate/dedupe.js` is shared
 * because cosine-collapse on candidate text is a general primitive, not an
 * ideate-specific behavior. The brainstorm dedupe phase is recorded as
 * `phase: 'idea-dedupe'` so transcripts remain distinguishable.
 *
 * Implementation lands in Sections 2-8 of `tasks.md`. This file is the
 * skeleton: types compile, entry point throws, callers can wire against the
 * shape.
 */

import type { ModelAdapter } from '../adapters/base.js';
import type {
  RunBrainstormInput,
  RunBrainstormResult,
} from './types.js';
// Intentional cross-module reuse: runDedupePhase is a general-purpose cosine-
// collapse primitive that lives under ideate/ because it shipped there first.
// Brainstorm's idea-dedupe phase reuses it unchanged (see design.md §runDedupePhase
// is reused unchanged). The lock test at __tests__/no-ideate-coupling.test.ts
// asserts this import exists (task 12.2) and that runIdeation is never imported.
// The actual call site lives in brainstorm/dedupe.ts; this import declares the
// intentional reuse at the orchestrator level so the architectural lock test
// (which reads orchestrator.ts source) can confirm the reuse decision.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { runDedupePhase as _runDedupePhase } from '../ideate/dedupe.js';

export type AdapterFactory = (model: string) => ModelAdapter;

/**
 * Entry point for one brainstorm run. Returns a fully-populated result
 * including partial `phases` when an error aborts mid-run, mirroring
 * `runIdeation`'s contract for server persistence.
 *
 * Not implemented yet — throws so server wiring fails loudly until Section 2+
 * lands.
 */
export async function runBrainstorm(
  _input: RunBrainstormInput,
  _factory: AdapterFactory,
): Promise<RunBrainstormResult> {
  throw new Error(
    'runBrainstorm is not yet implemented. See openspec/changes/add-brainstorm-mode/tasks.md sections 2-8.',
  );
}
