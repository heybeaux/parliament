import { describe, it, expect } from 'vitest';
import {
  NoopContextProvider,
  ACRContextProvider,
  formatResolvedContext,
  type ResolvedContext,
} from '../context.js';
import type { ResolutionPlan } from '@agentcapabilityruntime/schema';

const stubPlan: ResolutionPlan = {
  capabilities: [],
  totalBudget: 10000,
  windowSize: 128000,
  utilization: 0.078,
  conflicts: [],
  warnings: [],
};

const stubContext: ResolvedContext = {
  capabilities: ['jira-search', 'postgres-readonly', 'slack-notify'],
  constraints: ['SLA-2026-Q2', 'Compliance-PII-v3'],
  budget: { tokens: 10000, utilization: 0.078 },
  plan: stubPlan,
};

describe('NoopContextProvider', () => {
  it('resolve() returns null', async () => {
    const provider = new NoopContextProvider();
    const result = await provider.resolve('any topic');
    expect(result).toBeNull();
  });
});

describe('formatResolvedContext', () => {
  it('renders capabilities, constraints, and budget', () => {
    const output = formatResolvedContext(stubContext);
    expect(output).toContain('[Context] Available capabilities: jira-search, postgres-readonly, slack-notify');
    expect(output).toContain('[Constraints] Decision must respect: SLA-2026-Q2, Compliance-PII-v3');
    expect(output).toContain('[Budget]');
    expect(output).toContain('10,000 tokens');
  });

  it('omits capabilities line when empty', () => {
    const ctx: ResolvedContext = { ...stubContext, capabilities: [] };
    const output = formatResolvedContext(ctx);
    expect(output).not.toContain('[Context] Available capabilities');
    expect(output).toContain('[Budget]');
  });

  it('omits constraints line when empty', () => {
    const ctx: ResolvedContext = { ...stubContext, constraints: [] };
    const output = formatResolvedContext(ctx);
    expect(output).not.toContain('[Constraints]');
    expect(output).toContain('[Context] Available capabilities');
  });

  it('always includes budget line', () => {
    const ctx: ResolvedContext = { ...stubContext, capabilities: [], constraints: [] };
    const output = formatResolvedContext(ctx);
    expect(output).toContain('[Budget]');
    expect(output).toContain('10,000 tokens');
  });

  it('shows utilization percentage', () => {
    const output = formatResolvedContext(stubContext);
    expect(output).toContain('8% window utilization');
  });
});

describe('ACRContextProvider constructor', () => {
  it('constructs without throwing', () => {
    expect(() => new ACRContextProvider({ manifestPath: '/fake/.acr' })).not.toThrow();
  });

  it('constructs with all options without throwing', () => {
    expect(() => new ACRContextProvider({
      manifestPath: '/fake/.acr',
      budgetMultiplier: 0.9,
      cacheTtlMs: 30_000,
    })).not.toThrow();
  });
});
