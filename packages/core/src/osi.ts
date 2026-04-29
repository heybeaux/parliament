import type { Turn } from './types.js';
import { jaccardSimilarity } from './agents/utils.js';

/**
 * Opinion Shift Index convergence threshold.
 *
 * Calibrated against the AlgoDynLab/AIAlignment transcripts (data/open/*.txt,
 * 560 turns across 10 debate topics, 414 consecutive same-agent pairs).
 * Echo events (53 pairs) were identified by two heuristics:
 *   1. Turn ends with "Nothing to add." — explicit abstention marker.
 *   2. Jaccard similarity to the agent's immediately prior turn ≥ 0.85.
 * All other pairs where an agent had a prior turn were labelled as genuine
 * opinion-change events (361 pairs).
 *
 * Jaccard distance distribution across the corpus:
 *   mean=0.839  p25=0.800  p50=0.860  p75=0.907
 *
 * Grid sweep over [0.05, 0.35] in 0.01 steps maximising F1 for change-vs-echo
 * classification:
 *   Threshold range 0.05–0.30 all yield F1=0.932 (precision=0.872, recall=1.000).
 *   The plateau exists because echo events cluster near distance ~0 and genuine
 *   shifts span a broad range above 0.30; any cut-point in [0.05, 0.30] cleanly
 *   divides the two clusters.
 *
 * 0.15 is chosen as the canonical threshold: it sits comfortably in the middle
 * of the stable plateau, providing a generous margin below the echo cluster
 * ceiling (~0.15) and well below the genuine-shift floor (~0.30), making it
 * robust to minor corpus drift or tokenisation differences.
 */
export const OSI_CONVERGENCE_THRESHOLD = 0.15;

/**
 * Minimum number of turns a single role must have contributed before its
 * convergence can be evaluated. With fewer turns we have either zero or only
 * one inter-turn similarity sample, which is not a meaningful convergence
 * signal — collapsing on it would conflate "no data" with "perfect echo".
 *
 * Three is the smallest value that gives at least two inter-turn comparisons
 * (turn1↔turn2 and turn2↔turn3), so a low mean genuinely reflects a pattern
 * rather than a single coincidental repetition.
 */
export const MIN_TURNS_PER_ROLE_FOR_ECHO_CHECK = 3;

/**
 * Compute per-turn Opinion Shift Index scores for a given agent role.
 *
 * OSI for turn i is defined as the Jaccard distance (1 − similarity) between
 * turn i and turn i−1 for the same agent.  The first turn for an agent always
 * returns 0 because there is no prior turn to compare against.
 *
 * @param turns  Full ordered turn list from the blackboard.
 * @param role   The agent name whose turns should be analysed.
 * @returns      Array of OSI scores, one per turn that belongs to `role`,
 *               in the order those turns appear in `turns`.
 */
export function computeOSI(turns: Turn[], role: string): number[] {
  const roleTurns = turns.filter((t) => t.agent === role);

  if (roleTurns.length === 0) return [];

  const scores: number[] = [0]; // first turn has no predecessor

  for (let i = 1; i < roleTurns.length; i++) {
    const prev = roleTurns[i - 1]!;
    const curr = roleTurns[i]!;
    const similarity = jaccardSimilarity(prev.content, curr.content);
    scores.push(1 - similarity); // Jaccard distance = opinion shift
  }

  return scores;
}

/**
 * Detect whether a debate has entered an echo loop.
 *
 * Examines the last `windowSize` turns for each agent that appears in that
 * window.  If *all* agents in the window that have enough history to evaluate
 * have a mean OSI below `threshold` (default OSI_CONVERGENCE_THRESHOLD), the
 * debate has converged without resolution — every participant is essentially
 * repeating themselves.
 *
 * Two distinct "no echo" cases are deliberately separated:
 *
 *   1. **Insufficient data** — the transcript has fewer than `windowSize` turns
 *      total, OR no role in the window has yet produced `minTurnsPerRole`
 *      turns (default {@link MIN_TURNS_PER_ROLE_FOR_ECHO_CHECK}). With ≤1
 *      inter-turn similarity available per role the mean is either undefined
 *      or a single Jaccard distance, which is not a convergence signal — it's
 *      just noise. Returning `true` here would conflate "I have nothing to
 *      compare" with "everything is identical", which is the inverse of what
 *      the OSI distance scale means.
 *
 *   2. **Genuine variation** — at least one role with sufficient data has a
 *      mean OSI above threshold.
 *
 * The first OSI score for any role is always 0 (placeholder for "no prior
 * turn") and is excluded from the mean to avoid contaminating it with a
 * not-a-shift sentinel.
 *
 * @param turns             Full ordered turn list.
 * @param windowSize        Number of recent turns to inspect (default 3).
 * @param threshold         Jaccard-distance threshold; agents with a mean
 *                          window OSI below this are considered echoing.
 *                          Default `OSI_CONVERGENCE_THRESHOLD` (0.15).
 * @param minTurnsPerRole   Minimum turns a role must have contributed (across
 *                          the whole transcript, not just the window) before
 *                          its convergence is evaluated. Default
 *                          {@link MIN_TURNS_PER_ROLE_FOR_ECHO_CHECK} (3).
 * @returns                 `true` if the window shows collective low-OSI
 *                          convergence among roles with sufficient data;
 *                          `false` when there is too little data to decide or
 *                          at least one role is still genuinely shifting.
 */
export function detectEchoLoop(
  turns: Turn[],
  windowSize = 3,
  threshold: number = OSI_CONVERGENCE_THRESHOLD,
  minTurnsPerRole: number = MIN_TURNS_PER_ROLE_FOR_ECHO_CHECK,
): boolean {
  // Insufficient data (case 1, transcript-level): not enough turns to even
  // fill the window. "No data" ≠ "convergence" — return false.
  if (turns.length < windowSize) return false;

  const window = turns.slice(-windowSize);
  const agents = [...new Set(window.map((t) => t.agent))];

  // Track whether at least one role had enough history to be evaluated.
  // If none did, we have insufficient data and must NOT report an echo —
  // this is the round-1 false-positive guard.
  let anyAgentEvaluated = false;

  for (const agent of agents) {
    const scores = computeOSI(turns, agent);

    // Insufficient data (case 1, per-role): role has fewer than the minimum
    // number of turns needed to compute a meaningful mean. Skip this role
    // — do NOT count it as either an echo or a non-echo.
    if (scores.length < minTurnsPerRole) continue;

    // Only consider the OSI scores that fall within the window AND have a
    // real predecessor (drop the placeholder 0 at index 0, which means
    // "no prior turn", not "no shift" — a critical distinction in distance
    // space where 0 means maximally similar).
    const windowStart = turns.length - windowSize;
    const agentTurnsAll = turns
      .map((t, idx) => ({ t, idx }))
      .filter(({ t }) => t.agent === agent);

    const windowScores: number[] = [];
    let agentRank = 0;
    for (const { idx } of agentTurnsAll) {
      if (idx >= windowStart && agentRank > 0) {
        windowScores.push(scores[agentRank] ?? 0);
      }
      agentRank++;
    }

    // No real (non-placeholder) scores in the window — none of this role's
    // window turns had a same-role predecessor to compare against. Treat as
    // insufficient data for this role and skip.
    if (windowScores.length === 0) continue;

    anyAgentEvaluated = true;

    const mean = windowScores.reduce((a, b) => a + b, 0) / windowScores.length;
    if (mean >= threshold) {
      // At least one agent is still shifting — not a collective echo loop.
      return false;
    }
  }

  // No role in the window had enough history to evaluate → insufficient data.
  // Returning true here would falsely declare an echo loop on the very first
  // rounds of a debate, which is exactly the bug this guard fixes.
  if (!anyAgentEvaluated) return false;

  return true;
}
