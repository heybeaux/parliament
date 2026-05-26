import { describe, it, expect } from 'vitest';
import {
  dotProduct,
  weightedMean,
  softmax,
  cumulativeSum,
  linearInterpolate,
  elementwiseProduct,
} from '../float_operations.js';

// ---------------------------------------------------------------------------
// dotProduct
// ---------------------------------------------------------------------------

describe('dotProduct', () => {
  it('returns 0 for two empty arrays', () => {
    expect(dotProduct([], [])).toBe(0);
  });

  it('computes the correct dot product for simple integer vectors', () => {
    // [1,2,3] · [4,5,6] = 4+10+18 = 32
    expect(dotProduct([1, 2, 3], [4, 5, 6])).toBe(32);
  });

  it('computes correctly for a single-element pair', () => {
    expect(dotProduct([7], [3])).toBe(21);
  });

  it('handles negative values', () => {
    // [-1,2] · [3,-4] = -3 + -8 = -11
    expect(dotProduct([-1, 2], [3, -4])).toBe(-11);
  });

  it('handles floating-point values', () => {
    expect(dotProduct([0.5, 0.5], [2, 2])).toBeCloseTo(2, 10);
  });

  // -- bounds checks --

  it('throws RangeError when arrays have different lengths', () => {
    expect(() => dotProduct([1, 2], [1])).toThrow(RangeError);
    expect(() => dotProduct([1, 2], [1])).toThrow(/same length|different length/i);
  });

  it('error message names the function', () => {
    expect(() => dotProduct([1, 2], [1])).toThrow(/dotProduct/);
  });
});

// ---------------------------------------------------------------------------
// weightedMean
// ---------------------------------------------------------------------------

describe('weightedMean', () => {
  it('returns the unweighted mean when all weights are equal', () => {
    // [1, 2, 3] with equal weights → (1+2+3)/3 = 2
    expect(weightedMean([1, 2, 3], [1, 1, 1])).toBeCloseTo(2, 10);
  });

  it('fully weights a single value when only one weight is non-zero', () => {
    expect(weightedMean([10, 20, 30], [0, 1, 0])).toBeCloseTo(20, 10);
  });

  it('computes a weighted blend correctly', () => {
    // values=[0,1], weights=[3,1] → (0*3 + 1*1) / 4 = 0.25
    expect(weightedMean([0, 1], [3, 1])).toBeCloseTo(0.25, 10);
  });

  it('handles floating-point weights', () => {
    expect(weightedMean([1, 3], [0.5, 0.5])).toBeCloseTo(2, 10);
  });

  // -- bounds checks --

  it('throws RangeError when arrays have different lengths', () => {
    expect(() => weightedMean([1, 2, 3], [1, 1])).toThrow(RangeError);
    expect(() => weightedMean([1, 2, 3], [1, 1])).toThrow(/weightedMean/);
  });

  it('throws RangeError when total weight is zero', () => {
    expect(() => weightedMean([1, 2, 3], [0, 0, 0])).toThrow(RangeError);
    expect(() => weightedMean([1, 2, 3], [0, 0, 0])).toThrow(/total weight is zero/i);
  });
});

// ---------------------------------------------------------------------------
// softmax
// ---------------------------------------------------------------------------

describe('softmax', () => {
  it('returns [1] for a single-element array', () => {
    expect(softmax([42])).toEqual([1]);
  });

  it('returns equal probabilities for a uniform input', () => {
    const result = softmax([1, 1, 1]);
    for (const p of result) {
      expect(p).toBeCloseTo(1 / 3, 10);
    }
  });

  it('probabilities sum to 1', () => {
    const result = softmax([2, 1, 0.1]);
    const total = result.reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 10);
  });

  it('assigns the highest probability to the largest logit', () => {
    const result = softmax([10, 1, 1]);
    expect(result[0]).toBeGreaterThan(result[1]!);
    expect(result[0]).toBeGreaterThan(result[2]!);
  });

  it('is numerically stable for large logit values', () => {
    // Without the max-shift trick, Math.exp(1000) overflows to Infinity.
    const result = softmax([1000, 1001, 999]);
    const total = result.reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 10);
    expect(result.every((p) => Number.isFinite(p))).toBe(true);
  });

  it('is numerically stable for very negative logit values', () => {
    const result = softmax([-1000, -1001, -999]);
    const total = result.reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 10);
  });

  it('returns correct length', () => {
    expect(softmax([1, 2, 3, 4, 5])).toHaveLength(5);
  });

  // -- bounds checks --

  it('throws RangeError for an empty array', () => {
    expect(() => softmax([])).toThrow(RangeError);
    expect(() => softmax([])).toThrow(/softmax/);
    expect(() => softmax([])).toThrow(/empty/i);
  });
});

// ---------------------------------------------------------------------------
// cumulativeSum
// ---------------------------------------------------------------------------

describe('cumulativeSum', () => {
  it('returns an empty array for an empty input', () => {
    expect(cumulativeSum([])).toEqual([]);
  });

  it('returns a single-element array unchanged', () => {
    expect(cumulativeSum([5])).toEqual([5]);
  });

  it('computes the correct prefix sums', () => {
    // [1,2,3,4] → [1,3,6,10]
    expect(cumulativeSum([1, 2, 3, 4])).toEqual([1, 3, 6, 10]);
  });

  it('handles negative values', () => {
    expect(cumulativeSum([5, -3, 2])).toEqual([5, 2, 4]);
  });

  it('handles floating-point values', () => {
    const result = cumulativeSum([0.1, 0.2, 0.3]);
    expect(result[0]).toBeCloseTo(0.1, 10);
    expect(result[1]).toBeCloseTo(0.3, 10);
    expect(result[2]).toBeCloseTo(0.6, 10);
  });

  it('output has the same length as input', () => {
    const input = [10, 20, 30, 40, 50];
    expect(cumulativeSum(input)).toHaveLength(input.length);
  });
});

// ---------------------------------------------------------------------------
// linearInterpolate
// ---------------------------------------------------------------------------

describe('linearInterpolate', () => {
  it('returns the first sample at t=0', () => {
    expect(linearInterpolate([10, 20, 30], 0)).toBe(10);
  });

  it('returns the last sample at t=1', () => {
    expect(linearInterpolate([10, 20, 30], 1)).toBe(30);
  });

  it('returns the midpoint at t=0.5 for a two-element array', () => {
    expect(linearInterpolate([0, 100], 0.5)).toBeCloseTo(50, 10);
  });

  it('returns the midpoint sample at t=0.5 for a three-element array', () => {
    expect(linearInterpolate([0, 50, 100], 0.5)).toBeCloseTo(50, 10);
  });

  it('interpolates correctly between the first two samples at t=0.25 (3-element)', () => {
    // samples=[0,50,100], n=3, pos=0.25*2=0.5, lo=0, hi=1, frac=0.5
    // result = 0*(1-0.5) + 50*0.5 = 25
    expect(linearInterpolate([0, 50, 100], 0.25)).toBeCloseTo(25, 10);
  });

  it('handles a two-element array at an arbitrary t', () => {
    // samples=[4,8], t=0.25 → 4*0.75 + 8*0.25 = 5
    expect(linearInterpolate([4, 8], 0.25)).toBeCloseTo(5, 10);
  });

  // -- bounds checks --

  it('throws RangeError when samples has fewer than 2 entries (empty)', () => {
    expect(() => linearInterpolate([], 0.5)).toThrow(RangeError);
    expect(() => linearInterpolate([], 0.5)).toThrow(/linearInterpolate/);
    expect(() => linearInterpolate([], 0.5)).toThrow(/at least 2/i);
  });

  it('throws RangeError when samples has fewer than 2 entries (single)', () => {
    expect(() => linearInterpolate([42], 0.5)).toThrow(RangeError);
    expect(() => linearInterpolate([42], 0.5)).toThrow(/at least 2/i);
  });

  it('throws RangeError when t < 0', () => {
    expect(() => linearInterpolate([1, 2], -0.01)).toThrow(RangeError);
    expect(() => linearInterpolate([1, 2], -0.01)).toThrow(/\[0, 1\]/);
  });

  it('throws RangeError when t > 1', () => {
    expect(() => linearInterpolate([1, 2], 1.01)).toThrow(RangeError);
    expect(() => linearInterpolate([1, 2], 1.01)).toThrow(/\[0, 1\]/);
  });

  it('does not throw at t=0 or t=1 (boundary values are valid)', () => {
    expect(() => linearInterpolate([1, 2], 0)).not.toThrow();
    expect(() => linearInterpolate([1, 2], 1)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// elementwiseProduct
// ---------------------------------------------------------------------------

describe('elementwiseProduct', () => {
  it('returns an empty array for two empty inputs', () => {
    expect(elementwiseProduct([], [])).toEqual([]);
  });

  it('computes element-wise products correctly', () => {
    expect(elementwiseProduct([1, 2, 3], [4, 5, 6])).toEqual([4, 10, 18]);
  });

  it('handles a single-element pair', () => {
    expect(elementwiseProduct([7], [8])).toEqual([56]);
  });

  it('handles negative and floating-point values', () => {
    const result = elementwiseProduct([-1, 0.5], [2, 4]);
    expect(result[0]).toBeCloseTo(-2, 10);
    expect(result[1]).toBeCloseTo(2, 10);
  });

  it('output has the same length as the input arrays', () => {
    const result = elementwiseProduct([1, 2, 3, 4], [5, 6, 7, 8]);
    expect(result).toHaveLength(4);
  });

  // -- bounds checks --

  it('throws RangeError when arrays have different lengths', () => {
    expect(() => elementwiseProduct([1, 2, 3], [1, 2])).toThrow(RangeError);
    expect(() => elementwiseProduct([1, 2, 3], [1, 2])).toThrow(/elementwiseProduct/);
  });

  it('throws when first array is shorter', () => {
    expect(() => elementwiseProduct([1], [1, 2])).toThrow(RangeError);
  });

  it('throws when second array is shorter', () => {
    expect(() => elementwiseProduct([1, 2], [1])).toThrow(RangeError);
  });
});
