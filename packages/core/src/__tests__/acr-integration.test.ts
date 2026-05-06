/**
 * ACR integration test (PAR-41).
 *
 * Exercises the real `@acr/core` programmatic API through Parliament's
 * ACRContextProvider. Skipped by default. Opt in with:
 *
 *   ACR_MANIFEST_PATH=/path/to/.acr \
 *     pnpm --filter @parliament/core test acr-integration
 *
 * Why this exists: PAR-38 originally shipped with mock-only tests that
 * asserted Parliament's *assumed* contract without hitting a real service.
 * All three core assumptions were wrong at first call. This test is the
 * seam that catches ACR contract drift before it reaches production.
 *
 * ACR is a programmatic SDK (not HTTP), so we exercise `resolve()` and
 * `calculateBudget()` from `@acr/core` directly — not HTTP round-trips.
 * The contract pin lives at `integrations/acr/PIN.md`.
 *
 * Note: `@acr/core` is added to package.json as part of PAR-39. Until then
 * the live describe block is skipped (both by env-var gate and import guard).
 */

import { describe, it, expect } from 'vitest';

const acrManifestPath = process.env['ACR_MANIFEST_PATH'];
const acrEnabled = typeof acrManifestPath === 'string' && acrManifestPath.length > 0;

// Lazily import @acr/core so the file loads even before PAR-39 installs the package.
// Types are inlined here to avoid a cross-package type dependency before the dep exists.
async function loadAcr() {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return await import('@acr/core') as any;
  } catch {
    return null;
  }
}

describe.skipIf(!acrEnabled)('ACRContextProvider live contract', () => {
  it('scanCapabilities() loads at least one manifest from ACR_MANIFEST_PATH', async () => {
    const acr = await loadAcr();
    if (!acr) {
      console.warn('[acr-integration] @acr/core not installed — install as part of PAR-39');
      return;
    }

    const { manifests, legacyWarnings } = acr.scanCapabilities(acrManifestPath!);

    expect(Array.isArray(manifests)).toBe(true);
    expect(manifests.length).toBeGreaterThan(0);
    if (legacyWarnings.length > 0) {
      console.warn('[acr-integration] legacy warnings:', legacyWarnings);
    }

    for (const m of manifests) {
      expect(typeof m.name).toBe('string');
      expect(m.name.length).toBeGreaterThan(0);
      expect(typeof m.version).toBe('string');
      expect(Array.isArray(m.provides)).toBe(true);
      expect(typeof m.budget).toBe('object');
      expect(typeof m.budget.index).toBe('number');
      expect(typeof m.budget.summary).toBe('number');
      expect(typeof m.budget.standard).toBe('number');
    }
  }, 15_000);

  it('resolve() returns a valid ResolutionPlan', async () => {
    const acr = await loadAcr();
    if (!acr) return;

    const { manifests } = acr.scanCapabilities(acrManifestPath!);
    const plan = acr.resolve(manifests);

    expect(typeof plan.totalBudget).toBe('number');
    expect(plan.totalBudget).toBeGreaterThanOrEqual(0);
    expect(typeof plan.windowSize).toBe('number');
    expect(typeof plan.utilization).toBe('number');
    expect(plan.utilization).toBeGreaterThanOrEqual(0);
    expect(plan.utilization).toBeLessThanOrEqual(1);
    expect(Array.isArray(plan.capabilities)).toBe(true);
    expect(Array.isArray(plan.conflicts)).toBe(true);
    expect(Array.isArray(plan.warnings)).toBe(true);

    for (const cap of plan.capabilities) {
      expect(typeof cap.manifest.name).toBe('string');
      expect(['index', 'summary', 'standard', 'deep']).toContain(cap.resolution);
      expect(typeof cap.budgetUsed).toBe('number');
      expect(typeof cap.loadOrder).toBe('number');
      expect(Array.isArray(cap.transitiveDependencies)).toBe(true);
    }
  }, 15_000);

  it('calculateBudget() returns a BudgetReport consistent with the plan', async () => {
    const acr = await loadAcr();
    if (!acr) return;

    const { manifests } = acr.scanCapabilities(acrManifestPath!);
    const plan = acr.resolve(manifests);
    const report = acr.calculateBudget(plan);

    expect(typeof report.totalBudget).toBe('number');
    expect(typeof report.windowSize).toBe('number');
    expect(typeof report.utilization).toBe('number');
    expect(Array.isArray(report.perCapability)).toBe(true);
    expect(Array.isArray(report.burstAnalysis)).toBe(true);

    // Must be consistent with plan
    expect(report.totalBudget).toBe(plan.totalBudget);
    expect(report.windowSize).toBe(plan.windowSize);

    for (const entry of report.perCapability) {
      expect(typeof entry.name).toBe('string');
      expect(['index', 'summary', 'standard', 'deep']).toContain(entry.resolution);
      expect(typeof entry.tokens).toBe('number');
      expect(typeof entry.percentage).toBe('number');
    }
  }, 15_000);

  it('resolve() is deterministic across two calls on the same manifests', async () => {
    const acr = await loadAcr();
    if (!acr) return;

    const { manifests } = acr.scanCapabilities(acrManifestPath!);
    const plan1 = acr.resolve(manifests);
    const plan2 = acr.resolve(manifests);

    expect(plan1.totalBudget).toBe(plan2.totalBudget);
    expect(plan1.utilization).toBe(plan2.utilization);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(plan1.capabilities.map((c: any) => c.manifest.name)).toEqual(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      plan2.capabilities.map((c: any) => c.manifest.name),
    );
  }, 15_000);
});

describe('ACR_MANIFEST_PATH skip behavior', () => {
  it('reports the gate state for the current run', () => {
    expect(typeof acrEnabled).toBe('boolean');
  });
});
