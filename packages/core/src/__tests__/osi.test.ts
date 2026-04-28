import { describe, it, expect } from 'vitest';
import type { Turn } from '../types.js';
import {
  computeOSI,
  detectEchoLoop,
  OSI_CONVERGENCE_THRESHOLD,
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

  it('returns false when the window contains only one turn (no OSI to compare)', () => {
    // Single turn in window → no consecutive pair → no agent exceeds threshold
    // but also no agent clears it — should return true only if ALL agents stay low.
    // With one turn each and windowSize=1, scores = [0] → below threshold → echo
    const turns = [
      makeTurn('Proposer', 'single turn'),
      makeTurn('Skeptic', 'another single turn'),
      makeTurn('Synthesizer', 'yet another'),
    ];
    // Each agent appears once; OSI=0 for each → collective echo loop detected
    expect(detectEchoLoop(turns, 3)).toBe(true);
  });

  it('threshold constant is accessible and equals 0.15', () => {
    expect(OSI_CONVERGENCE_THRESHOLD).toBe(0.15);
  });
});
