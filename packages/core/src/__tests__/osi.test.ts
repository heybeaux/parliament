import { describe, it, expect } from 'vitest';
import type { Turn } from '../types.js';
import {
  computeOSI,
  detectEchoLoop,
  OSI_CONVERGENCE_THRESHOLD,
  MIN_TURNS_PER_ROLE_FOR_ECHO_CHECK,
} from '../osi.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTurn(agent: string, content: string): Turn {
  return {
    agent,
    neurotype: 'structured',
    model: 'test-model',
    content,
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// computeOSI
// ---------------------------------------------------------------------------

describe('computeOSI', () => {
  it('returns an empty array when there are no turns for the given role', () => {
    const turns = [makeTurn('Proposer', 'hello world')];
    expect(computeOSI(turns, 'Skeptic')).toEqual([]);
  });

  it('returns [0] for a single turn (no prior to compare against)', () => {
    const turns = [makeTurn('Proposer', 'hello world')];
    expect(computeOSI(turns, 'Proposer')).toEqual([0]);
  });

  it('returns length-N array for N turns of the given role', () => {
    const turns = [
      makeTurn('Proposer', 'first turn content'),
      makeTurn('Skeptic', 'interspersed skeptic'),
      makeTurn('Proposer', 'second turn content'),
      makeTurn('Proposer', 'third turn content'),
    ];
    const scores = computeOSI(turns, 'Proposer');
    expect(scores).toHaveLength(3);
  });

  it('first score is always 0', () => {
    const turns = [
      makeTurn('Proposer', 'first'),
      makeTurn('Proposer', 'completely different second'),
    ];
    const scores = computeOSI(turns, 'Proposer');
    expect(scores[0]).toBe(0);
  });

  it('returns Jaccard distance (not similarity) for subsequent turns', () => {
    // Two identical turns → similarity 1.0 → distance 0.0
    const turns = [
      makeTurn('Proposer', 'the exact same content'),
      makeTurn('Proposer', 'the exact same content'),
    ];
    const scores = computeOSI(turns, 'Proposer');
    expect(scores[1]).toBeCloseTo(0, 5);
  });

  it('yields high OSI when consecutive turns share no vocabulary', () => {
    // Completely disjoint word sets → Jaccard similarity 0 → distance 1
    const turns = [
      makeTurn('Proposer', 'alpha beta gamma'),
      makeTurn('Proposer', 'delta epsilon zeta'),
    ];
    const scores = computeOSI(turns, 'Proposer');
    expect(scores[1]).toBeCloseTo(1, 5);
  });

  it('ignores turns from other roles when computing scores', () => {
    // Skeptic turns are interspersed but should not affect Proposer OSI
    const turns = [
      makeTurn('Proposer', 'alpha beta gamma'),
      makeTurn('Skeptic', 'unrelated skeptic noise'),
      makeTurn('Skeptic', 'more skeptic noise'),
      makeTurn('Proposer', 'alpha beta gamma'), // identical to first Proposer turn
    ];
    const scores = computeOSI(turns, 'Proposer');
    expect(scores).toHaveLength(2);
    expect(scores[1]).toBeCloseTo(0, 5); // same content → distance 0
  });

  it('computes partial overlap correctly', () => {
    // "a b c" vs "b c d" → intersection {b,c}, union {a,b,c,d} → similarity 2/4 = 0.5 → distance 0.5
    const turns = [
      makeTurn('Proposer', 'a b c'),
      makeTurn('Proposer', 'b c d'),
    ];
    const scores = computeOSI(turns, 'Proposer');
    expect(scores[1]).toBeCloseTo(0.5, 5);
  });
});

// ---------------------------------------------------------------------------
// detectEchoLoop
// ---------------------------------------------------------------------------

describe('detectEchoLoop', () => {
  it('returns false when there are fewer turns than windowSize', () => {
    const turns = [
      makeTurn('Proposer', 'hello'),
      makeTurn('Proposer', 'hello'),
    ];
    expect(detectEchoLoop(turns, 3)).toBe(false);
  });

  it('returns true when last N same-role turns all have OSI below threshold', () => {
    // All Proposer turns have nearly identical content → OSI ~0 → echo loop
    const repeatedContent = 'we need to consider all perspectives carefully';
    const turns = [
      makeTurn('Proposer', repeatedContent),
      makeTurn('Proposer', repeatedContent),
      makeTurn('Proposer', repeatedContent),
    ];
    expect(detectEchoLoop(turns, 3)).toBe(true);
  });

  it('returns false when at least one agent shows variation above threshold', () => {
    // Proposer echoes, but Skeptic introduces genuinely different content
    const proposerContent = 'same thing over and over again';
    const turns = [
      makeTurn('Proposer', proposerContent),
      makeTurn('Skeptic', 'first skeptic point about something else entirely'),
      makeTurn('Proposer', proposerContent),
      makeTurn('Skeptic', 'radically different second observation with new words'),
    ];
    // windowSize=4 captures all turns; Skeptic OSI should be high → no echo loop
    expect(detectEchoLoop(turns, 4)).toBe(false);
  });

  it('uses default windowSize of 3', () => {
    const repeatedContent = 'the same repeated assertion over and over';
    // Use two different roles so the "earlier different" turn is from Skeptic
    // and does not pollute Proposer OSI scores within the window.
    const turns = [
      makeTurn('Skeptic', 'earlier skeptic turn outside the window'),
      makeTurn('Proposer', repeatedContent),
      makeTurn('Proposer', repeatedContent),
      makeTurn('Proposer', repeatedContent),
    ];
    // Window = last 3 turns, all Proposer with identical content.
    // Proposer OSI within the window: first Proposer turn has no prior → 0,
    // second and third compare identical strings → 0.  Mean = 0 < threshold.
    // Skeptic is not in the window at all.  detectEchoLoop should return true.
    expect(detectEchoLoop(turns)).toBe(true);
  });

  it('returns false when every role in the window has only one turn (insufficient data)', () => {
    // Single turn per agent → no inter-turn similarities to average. The
    // placeholder OSI=0 for the first turn means "no prior turn", NOT
    // "perfectly echoing" — treating it as the latter caused round-1 false
    // positives. Should return false (insufficient data), not true.
    const turns = [
      makeTurn('Proposer', 'single turn'),
      makeTurn('Skeptic', 'another single turn'),
      makeTurn('Synthesizer', 'yet another'),
    ];
    expect(detectEchoLoop(turns, 3)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Minimum-turns guard — fixes the round-1 false-positive bug.
  // -------------------------------------------------------------------------

  it('returns false for a 0-turn transcript (no data)', () => {
    expect(detectEchoLoop([], 3)).toBe(false);
  });

  it('returns false for a 1-turn transcript (no data)', () => {
    const turns = [makeTurn('Proposer', 'opening salvo')];
    expect(detectEchoLoop(turns, 3)).toBe(false);
  });

  it('returns false for a 2-turn transcript even when both turns are identical', () => {
    // Critical guard: two identical turns is NOT yet an echo loop — that's a
    // single coincidence with no opportunity to demonstrate persistence.
    const repeated = 'identical sentence repeated verbatim again';
    const turns = [
      makeTurn('Proposer', repeated),
      makeTurn('Proposer', repeated),
    ];
    // windowSize=2 fills the window; per-role data is still insufficient
    // (only 2 turns → 1 inter-turn comparison, below MIN_TURNS_PER_ROLE).
    expect(detectEchoLoop(turns, 2)).toBe(false);
  });

  it('returns true for a 3-turn same-role transcript with identical content (sufficient data, low convergence)', () => {
    const repeated = 'identical sentence repeated verbatim again';
    const turns = [
      makeTurn('Proposer', repeated),
      makeTurn('Proposer', repeated),
      makeTurn('Proposer', repeated),
    ];
    expect(detectEchoLoop(turns, 3)).toBe(true);
  });

  it('returns false for a 3-turn same-role transcript with diverging content (sufficient data, high OSI)', () => {
    const turns = [
      makeTurn('Proposer', 'apples bananas cherries dates elderberries'),
      makeTurn('Proposer', 'figs grapes honeydew imbe jackfruit'),
      makeTurn('Proposer', 'kiwi lemon mango nectarine olive'),
    ];
    expect(detectEchoLoop(turns, 3)).toBe(false);
  });

  it('does not falsely declare echo on round-1 transcripts (1 turn per role across 3 roles)', () => {
    // This is the exact shape of the bug: round 1 produces one Proposer +
    // one Skeptic + one Synthesizer turn, the Sentry call fires
    // detectEchoLoop with windowSize=3, and prior to the fix every role's
    // mean was 0 (the no-prior-turn placeholder) → false positive collapse.
    const turns = [
      makeTurn('Proposer', 'a reasoned proposal'),
      makeTurn('Skeptic', 'a targeted critique'),
      makeTurn('Synthesizer', 'tentative synthesis'),
    ];
    expect(detectEchoLoop(turns, 3)).toBe(false);
  });

  it('respects a custom minTurnsPerRole', () => {
    // With minTurnsPerRole=2, two identical turns IS enough to trip echo.
    const repeated = 'identical sentence repeated verbatim again';
    const turns = [
      makeTurn('Proposer', repeated),
      makeTurn('Proposer', repeated),
    ];
    expect(detectEchoLoop(turns, 2, OSI_CONVERGENCE_THRESHOLD, 2)).toBe(true);
  });

  it('threshold constant is accessible and equals 0.15', () => {
    expect(OSI_CONVERGENCE_THRESHOLD).toBe(0.15);
  });

  it('MIN_TURNS_PER_ROLE_FOR_ECHO_CHECK constant is accessible and equals 3', () => {
    expect(MIN_TURNS_PER_ROLE_FOR_ECHO_CHECK).toBe(3);
  });
});
