import { resolve as acrResolve, calculateBudget, scanCapabilities } from '@agentcapabilityruntime/core';
import type { ResolutionPlan } from '@agentcapabilityruntime/schema';

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

    const { manifests } = scanCapabilities(this.manifestPath);
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
  lines.push(
    `[Budget] ${ctx.budget.tokens.toLocaleString()} tokens · ${Math.round(ctx.budget.utilization * 100)}% window utilization`,
  );
  return lines.join('\n');
}
