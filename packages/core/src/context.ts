import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { resolve as acrResolve, calculateBudget } from '@acr/core';
import type { ResolutionPlan, CapabilityManifest } from '@acr/schema';

/**
 * ESM-safe manifest scanner. Replaces `scanCapabilities` from `@acr/core`
 * which uses inline `require()` calls incompatible with Parliament's ESM build.
 * Reads `capability.yaml` from each subdirectory of `baseDir`.
 */
function loadManifests(baseDir: string): CapabilityManifest[] {
  if (!existsSync(baseDir)) return [];
  const manifests: CapabilityManifest[] = [];
  for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(baseDir, entry.name, 'capability.yaml');
    if (!existsSync(manifestPath)) continue;
    try {
      const raw = readFileSync(manifestPath, 'utf-8');
      manifests.push(parseYaml(raw) as CapabilityManifest);
    } catch {
      // Skip malformed manifests — fail-soft per-entry
    }
  }
  return manifests;
}

export interface ResolvedContext {
  capabilities: string[];
  constraints: string[];
  budget: { tokens: number; utilization: number };
  plan: ResolutionPlan;
}

export interface ContextProvider {
  resolve(topic: string): Promise<ResolvedContext | null>;
}

export class NoopContextProvider implements ContextProvider {
  async resolve(_topic: string): Promise<null> {
    return null;
  }
}

export interface ACRContextProviderConfig {
  manifestPath: string;
  budgetMultiplier?: number;
  cacheTtlMs?: number;
}

export class ACRContextProvider implements ContextProvider {
  private readonly manifestPath: string;
  private readonly budgetMultiplier: number;
  private readonly cacheTtlMs: number;
  private cache: { key: string; result: ResolvedContext; expiresAt: number } | null = null;

  constructor(config: ACRContextProviderConfig) {
    this.manifestPath = config.manifestPath;
    this.budgetMultiplier = config.budgetMultiplier ?? 1.0;
    this.cacheTtlMs = config.cacheTtlMs ?? 60_000;
  }

  async resolve(topic: string): Promise<ResolvedContext | null> {
    const now = Date.now();
    if (this.cache !== null && this.cache.key === topic && this.cache.expiresAt > now) {
      return this.cache.result;
    }

    const manifests = loadManifests(this.manifestPath);
    if (manifests.length === 0) return null;

    const plan = acrResolve(manifests);
    const report = calculateBudget(plan);

    const capabilities = plan.capabilities.map((c) => c.manifest.name);
    const constraints = plan.capabilities.flatMap((c) => c.manifest.constraints ?? []);
    const tokens = Math.round(report.totalBudget * this.budgetMultiplier);

    const result: ResolvedContext = {
      capabilities,
      constraints,
      budget: { tokens, utilization: plan.utilization },
      plan,
    };

    this.cache = { key: topic, result, expiresAt: now + this.cacheTtlMs };
    return result;
  }
}

export function formatResolvedContext(ctx: ResolvedContext): string {
  const lines: string[] = [];
  if (ctx.capabilities.length > 0) {
    lines.push(`[Context] Available capabilities: ${ctx.capabilities.join(', ')}`);
  }
  if (ctx.constraints.length > 0) {
    lines.push(`[Constraints] Decision must respect: ${ctx.constraints.join(', ')}`);
  }
  // Budget is used by the engine's cutoff logic only — not surfaced to agents.
  return lines.join('\n');
}
