import type { Blackboard } from '../types.js';

/**
 * Result of an agent's `generate()` call.
 *
 * Every neurotype-style agent (Proposer, Skeptic, and the eight new neurotypes
 * landing in Stage 1) MUST run its raw model output through `enforceWordCap`
 * (see `./utils.ts`) before returning. The default cap is 200 words and is
 * load-bearing for downstream metrics — the OSI scorer, residue calculation,
 * and Timeline UI all assume this cap. The `truncated` flag MUST faithfully
 * reflect whether the cap was applied; downstream consumers (the Timeline UI
 * truncation badge, in particular) rely on it.
 *
 * The Sentry and Synthesizer agents are exceptions:
 *   - Sentry produces a structured classifier signal, not free prose, and
 *     therefore does not pass through the word cap.
 *   - Synthesizer's `summary` field is capped, but its surrounding JSON
 *     envelope (confidence, consensus, agreed[], unresolved[]) is not.
 */
export interface AgentResult {
  content: string;
  truncated: boolean;
}

/**
 * Contract for every agent the deliberation engine can step.
 *
 * Implementations MUST:
 *   - expose a stable string `role` (display name in the transcript) and
 *     `neurotype` (kebab-case ID matching the registry, e.g.
 *     `"devils-advocate"`); see `./registry.ts` for the ID convention.
 *   - take a read-only view of the `Blackboard` and return a fresh
 *     `AgentResult`. Agents MUST NOT mutate `blackboard.turns` directly —
 *     the engine appends turns. Agents MAY append to `blackboard.conflicts`
 *     (Skeptic does this when it detects explicit disagreement).
 *   - apply the 200-word cap via `enforceWordCap` before returning.
 */
export interface Agent {
  role: string;
  neurotype: string;
  readonly modelName: string;
  /**
   * Optional plain-language posture label (e.g. "evidence-first" for
   * Empiricist, "adversarial" for Skeptic, "reconciliation" for Synthesizer).
   * The deliberation engine writes this into `Turn.neurotype_posture` so the
   * Stage 3 Observability UI can render a human-readable posture without
   * decoding the kebab-case neurotype ID.
   *
   * Optional for backward-compat with mock agents in existing test files.
   * When omitted, the engine defaults `Turn.neurotype_posture` to the
   * agent's `neurotype` so the wire field is always populated.
   *
   * PAR-10 — additive observability enrichment.
   */
  readonly posture?: string;
  generate(blackboard: Blackboard): Promise<AgentResult>;
}
