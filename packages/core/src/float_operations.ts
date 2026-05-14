/**
 * float_operations.ts — Bounds-checked array-based float math utilities.
 *
 * Every function in this module accesses arrays by numeric index. TypeScript
 * does NOT throw on out-of-bounds reads; it silently returns `undefined`,
 * which coerces to `NaN` in arithmetic. `NaN` then propagates silently
 * through all subsequent calculations, producing wrong results or downstream
 * crashes with no indication of where the bad index occurred.
 *
 * All public functions here perform explicit bounds checks (lower AND upper)
 * before every index access and throw a descriptive `RangeError` on violation.
 */

// ---------------------------------------------------------------------------
// Internal helper
// ---------------------------------------------------------------------------

/**
 * Assert that `index` is a valid index into an array of `length` elements.
 * Throws `RangeError` with a descriptive message when the assertion fails.
 *
 * @param index   The index to validate.
 * @param length  The length of the array being accessed.
 * @param context A short label (e.g. function name or array name) included in
 *                the error message for quick diagnostics.
 */
function assertInBounds(index: number, length: number, context: string): void {
  if (index < 0 || index >= length) {
    throw new RangeError(
      `${context}: index ${index} is out of bounds for array of length ${length}`,
    );
  }
}

// ---------------------------------------------------------------------------
// dotProduct
// ---------------------------------------------------------------------------

/**
 * Compute the dot product of two numeric arrays.
 *
 * Both arrays must have the same length. Every element is accessed by index
 * after an explicit bounds check so that a length mismatch — or a bug that
 * produces an index >= length — surfaces immediately as a `RangeError` rather
 * than propagating `NaN` through the accumulated sum.
 *
 * @param a First vector.
 * @param b Second vector; must be the same length as `a`.
 * @returns  The scalar dot product `Σ a[i] * b[i]`.
 * @throws   `RangeError` if the arrays have different lengths or if any
 *           computed index falls outside either array's bounds.
 */
export function dotProduct(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) {
    throw new RangeError(
      `dotProduct: arrays must have the same length (got ${a.length} and ${b.length})`,
    );
  }

  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    assertInBounds(i, a.length, 'dotProduct(a)');
    assertInBounds(i, b.length, 'dotProduct(b)');
    sum += a[i]! * b[i]!;
  }
  return sum;
}

// ---------------------------------------------------------------------------
// weightedMean
// ---------------------------------------------------------------------------

/**
 * Compute the weighted arithmetic mean of a value array using a parallel
 * weights array.
 *
 * Both arrays must have the same length and the weights must sum to a positive
 * value. Index accesses are bounds-checked before each read.
 *
 * @param values  The values to average.
 * @param weights Non-negative weights; need not be normalised.
 * @returns       `Σ (values[i] * weights[i]) / Σ weights[i]`.
 * @throws        `RangeError` if the arrays have different lengths or if any
 *                index falls outside bounds.
 * @throws        `RangeError` if the total weight is zero (would produce ±Inf
 *                or NaN on division).
 */
export function weightedMean(
  values: readonly number[],
  weights: readonly number[],
): number {
  if (values.length !== weights.length) {
    throw new RangeError(
      `weightedMean: values and weights must have the same length (got ${values.length} and ${weights.length})`,
    );
  }

  let weightedSum = 0;
  let totalWeight = 0;

  for (let i = 0; i < values.length; i++) {
    assertInBounds(i, values.length, 'weightedMean(values)');
    assertInBounds(i, weights.length, 'weightedMean(weights)');
    const w = weights[i]!;
    weightedSum += values[i]! * w;
    totalWeight += w;
  }

  if (totalWeight === 0) {
    throw new RangeError('weightedMean: total weight is zero; cannot divide');
  }

  return weightedSum / totalWeight;
}

// ---------------------------------------------------------------------------
// softmax
// ---------------------------------------------------------------------------

/**
 * Compute the softmax of a numeric array.
 *
 * Uses the numerically stable max-shift variant: each element is shifted by
 * the array maximum before exponentiation to prevent overflow. Every index is
 * bounds-checked before access in both the max-finding pass and the
 * normalisation pass.
 *
 * @param logits The input scores (any real numbers; need not be probabilities).
 * @returns      A probability distribution over the same indices, summing to 1.
 * @throws       `RangeError` if `logits` is empty or if any index falls
 *               outside bounds.
 */
export function softmax(logits: readonly number[]): number[] {
  if (logits.length === 0) {
    throw new RangeError('softmax: input array must not be empty');
  }

  // Pass 1: find the maximum value for numerical stability.
  assertInBounds(0, logits.length, 'softmax(max-init)');
  let max = logits[0]!;
  for (let i = 1; i < logits.length; i++) {
    assertInBounds(i, logits.length, 'softmax(max-scan)');
    if (logits[i]! > max) {
      max = logits[i]!;
    }
  }

  // Pass 2: exponentiate the shifted values.
  const exps: number[] = new Array(logits.length);
  let sumExp = 0;
  for (let i = 0; i < logits.length; i++) {
    assertInBounds(i, logits.length, 'softmax(exp)');
    const e = Math.exp(logits[i]! - max);
    exps[i] = e;
    sumExp += e;
  }

  // Pass 3: normalise.
  const result: number[] = new Array(logits.length);
  for (let i = 0; i < logits.length; i++) {
    assertInBounds(i, exps.length, 'softmax(normalise)');
    result[i] = exps[i]! / sumExp;
  }

  return result;
}

// ---------------------------------------------------------------------------
// cumulativeSum
// ---------------------------------------------------------------------------

/**
 * Compute the prefix (cumulative) sum of a numeric array.
 *
 * Returns an array of the same length where `result[i] = Σ values[0..i]`.
 * Every index is bounds-checked before access.
 *
 * @param values Source array.
 * @returns      Prefix-sum array of the same length.
 * @throws       `RangeError` if any computed index falls outside `values`'s
 *               bounds.
 */
export function cumulativeSum(values: readonly number[]): number[] {
  if (values.length === 0) return [];

  const result: number[] = new Array(values.length);
  assertInBounds(0, values.length, 'cumulativeSum(init)');
  result[0] = values[0]!;

  for (let i = 1; i < values.length; i++) {
    assertInBounds(i, values.length, 'cumulativeSum(read)');
    assertInBounds(i - 1, result.length, 'cumulativeSum(prev)');
    result[i] = result[i - 1]! + values[i]!;
  }

  return result;
}

// ---------------------------------------------------------------------------
// linearInterpolate
// ---------------------------------------------------------------------------

/**
 * Linearly interpolate a value at position `t` (in [0, 1]) within a
 * uniformly-spaced sample array.
 *
 * The array is treated as samples at positions 0, 1/(n-1), 2/(n-1), …, 1.
 * For `t` in [k/(n-1), (k+1)/(n-1)] the returned value is the linear blend
 * between `samples[k]` and `samples[k+1]`. Both the lower and upper bracket
 * indices are bounds-checked before access.
 *
 * @param samples Uniformly-spaced sample values; must have at least 2 entries.
 * @param t       Interpolation parameter in [0, 1].
 * @returns       The linearly interpolated value at `t`.
 * @throws        `RangeError` if `samples` has fewer than 2 entries.
 * @throws        `RangeError` if `t` is outside [0, 1].
 * @throws        `RangeError` if any computed bracket index falls outside
 *                `samples`'s bounds (guards against floating-point edge cases).
 */
export function linearInterpolate(samples: readonly number[], t: number): number {
  if (samples.length < 2) {
    throw new RangeError(
      `linearInterpolate: samples array must have at least 2 entries (got ${samples.length})`,
    );
  }
  if (t < 0 || t > 1) {
    throw new RangeError(
      `linearInterpolate: t must be in [0, 1] (got ${t})`,
    );
  }

  // Map t ∈ [0,1] onto the continuous index space [0, n-1].
  const n = samples.length;
  const pos = t * (n - 1);
  const lo = Math.floor(pos);
  // Clamp hi to n-1 in case floating-point arithmetic yields pos === n-1
  // exactly — `Math.ceil` would produce n, which is one past the end.
  const hi = Math.min(Math.ceil(pos), n - 1);

  assertInBounds(lo, samples.length, 'linearInterpolate(lo)');
  assertInBounds(hi, samples.length, 'linearInterpolate(hi)');

  if (lo === hi) return samples[lo]!;

  const frac = pos - lo;
  return samples[lo]! * (1 - frac) + samples[hi]! * frac;
}

// ---------------------------------------------------------------------------
// elementwiseProduct
// ---------------------------------------------------------------------------

/**
 * Compute the element-wise (Hadamard) product of two numeric arrays.
 *
 * Both arrays must have the same length. Every index is bounds-checked before
 * access in both arrays.
 *
 * @param a First array.
 * @param b Second array; must be the same length as `a`.
 * @returns  A new array where `result[i] = a[i] * b[i]`.
 * @throws   `RangeError` if the arrays have different lengths or if any index
 *           falls outside either array's bounds.
 */
export function elementwiseProduct(
  a: readonly number[],
  b: readonly number[],
): number[] {
  if (a.length !== b.length) {
    throw new RangeError(
      `elementwiseProduct: arrays must have the same length (got ${a.length} and ${b.length})`,
    );
  }

  const result: number[] = new Array(a.length);
  for (let i = 0; i < a.length; i++) {
    assertInBounds(i, a.length, 'elementwiseProduct(a)');
    assertInBounds(i, b.length, 'elementwiseProduct(b)');
    result[i] = a[i]! * b[i]!;
  }
  return result;
}
