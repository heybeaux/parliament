/**
 * PAR-38 — Memory provider abstraction. Lets the engine (a) recall past
 * decisions before round 1 and inject them onto the blackboard as a
 * `## Memory` block every agent sees, and (b) write the final outcome back to
 * the provider after the deliberation terminates.
 *
 * The interface is provider-agnostic by design: the OSS build runs with
 * `provider: 'none'` (no-op), the cloud build wires `EngramMemoryProvider`,
 * and tests inject in-memory stubs. All provider methods are fail-soft — the
 * engine logs and proceeds when a provider throws so a flaky memory backend
 * cannot block deliberation.
 */

export type MemoryLayer = 'IDENTITY' | 'PROJECT' | 'SESSION' | 'TASK' | 'INSIGHT';

export interface MemoryFragment {
  id: string;
  content: string;
  layer: MemoryLayer;
  score: number;
  createdAt: string;
}

/**
 * Outcome shape passed to `remember()` after a deliberation terminates.
 * Carries enough structure for the provider to persist a meaningful record
 * without forcing it to know about every internal Parliament type.
 */
export interface MemoryOutcome {
  topic: string;
  /** 'consensus' | 'echo_loop' | 'max_rounds' | 'red_agent_triggered' */
  terminationReason: string;
  /** The synthesizer's final reconciled text, or null when split. */
  synthesis: string | null;
  /** Weighted fraction of unresolved conflicts, 0–1. */
  residueScore: number;
  /** How many rounds the debate ran. */
  totalRounds: number;
  /** Distinct agent role labels that participated, in first-seen order. */
  agents: string[];
}

export interface RecallOptions {
  /** Max fragments to return. */
  limit: number;
  /** Per-account scoping; passed through as the provider's tenant header. */
  agentId: string;
}

export interface RememberOptions {
  /** Per-account scoping. */
  agentId: string;
}

export interface MemoryProvider {
  recall(topic: string, opts: RecallOptions): Promise<MemoryFragment[]>;
  remember(outcome: MemoryOutcome, opts: RememberOptions): Promise<void>;
}

/**
 * No-op provider used by the OSS build and as the safe default when no
 * memory configuration is supplied. Its presence keeps the engine free of
 * provider-presence branching: a `MemoryProvider` is always callable.
 */
export class NoopMemoryProvider implements MemoryProvider {
  async recall(_topic: string, _opts: RecallOptions): Promise<MemoryFragment[]> {
    return [];
  }

  async remember(_outcome: MemoryOutcome, _opts: RememberOptions): Promise<void> {
    return;
  }
}

export interface EngramMemoryProviderConfig {
  endpoint: string;
  apiKey?: string;
  /** Layers to filter recall against. Default: ['INSIGHT', 'PROJECT']. */
  layers?: MemoryLayer[];
  /** Override the global fetch implementation (tests). */
  fetchImpl?: typeof fetch;
  /** Override clock (tests). */
  now?: () => Date;
}

interface EngramRecallResponse {
  results?: Array<{
    id?: string;
    content?: string;
    text?: string;
    layer?: string;
    score?: number;
    createdAt?: string;
    created_at?: string;
  }>;
}

/**
 * Adapter for the Engram HTTP API. Maps `recall` → `POST /v1/memories/query`
 * and `remember` → `POST /v1/memories`. The Engram service authenticates with
 * the `x-am-agent-id` header (per-account tenant id); the optional `apiKey`
 * is forwarded as a bearer token when present.
 *
 * The adapter trusts the engine to call it inside a try/catch — it surfaces
 * errors verbatim so the engine can log them with the failing operation
 * tagged in the trace.
 */
export class EngramMemoryProvider implements MemoryProvider {
  private readonly endpoint: string;
  private readonly apiKey: string | undefined;
  private readonly layers: MemoryLayer[];
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(config: EngramMemoryProviderConfig) {
    this.endpoint = config.endpoint.replace(/\/$/, '');
    this.apiKey = config.apiKey;
    this.layers = config.layers ?? ['INSIGHT', 'PROJECT'];
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.now = config.now ?? (() => new Date());
  }

  async recall(topic: string, opts: RecallOptions): Promise<MemoryFragment[]> {
    const res = await this.fetchImpl(`${this.endpoint}/v1/memories/query`, {
      method: 'POST',
      headers: this.buildHeaders(opts.agentId),
      body: JSON.stringify({
        query: topic,
        limit: opts.limit,
        layers: this.layers,
      }),
    });

    if (!res.ok) {
      throw new Error(`engram recall failed: ${res.status} ${res.statusText}`);
    }

    const body = (await res.json()) as EngramRecallResponse;
    const results = body.results ?? [];
    return results
      .filter((r) => typeof (r.content ?? r.text) === 'string')
      .map((r) => ({
        id: typeof r.id === 'string' ? r.id : '',
        content: (r.content ?? r.text ?? '').trim(),
        layer: this.normalizeLayer(r.layer),
        score: typeof r.score === 'number' ? r.score : 0,
        createdAt:
          typeof r.createdAt === 'string'
            ? r.createdAt
            : typeof r.created_at === 'string'
              ? r.created_at
              : this.now().toISOString(),
      }));
  }

  async remember(outcome: MemoryOutcome, opts: RememberOptions): Promise<void> {
    const summary = formatOutcomeForMemory(outcome);
    const res = await this.fetchImpl(`${this.endpoint}/v1/memories`, {
      method: 'POST',
      headers: this.buildHeaders(opts.agentId),
      body: JSON.stringify({
        content: summary,
        layer: 'INSIGHT',
        metadata: {
          source: 'parliament',
          topic: outcome.topic,
          terminationReason: outcome.terminationReason,
          residueScore: outcome.residueScore,
          totalRounds: outcome.totalRounds,
          agents: outcome.agents,
        },
      }),
    });

    if (!res.ok) {
      throw new Error(`engram remember failed: ${res.status} ${res.statusText}`);
    }
  }

  private buildHeaders(agentId: string): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-am-agent-id': agentId,
    };
    if (this.apiKey !== undefined && this.apiKey.length > 0) {
      headers.authorization = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  private normalizeLayer(raw: unknown): MemoryLayer {
    const valid: readonly MemoryLayer[] = [
      'IDENTITY',
      'PROJECT',
      'SESSION',
      'TASK',
      'INSIGHT',
    ];
    if (typeof raw === 'string') {
      const upper = raw.toUpperCase() as MemoryLayer;
      if (valid.includes(upper)) return upper;
    }
    return 'INSIGHT';
  }
}

/**
 * Formats a deliberation outcome into the prose body Engram stores. The
 * `metadata` field carries the structured fields; the `content` is the
 * human-readable summary that future `recall()` calls match against.
 */
export function formatOutcomeForMemory(outcome: MemoryOutcome): string {
  const lines = [
    `Topic: ${outcome.topic}`,
    `Outcome: ${outcome.terminationReason} after ${outcome.totalRounds} round${outcome.totalRounds === 1 ? '' : 's'} (residue ${outcome.residueScore.toFixed(2)})`,
  ];
  if (outcome.synthesis !== null && outcome.synthesis.trim().length > 0) {
    lines.push(`Synthesis: ${outcome.synthesis.trim()}`);
  }
  if (outcome.agents.length > 0) {
    lines.push(`Participants: ${outcome.agents.join(', ')}`);
  }
  return lines.join('\n');
}

/**
 * Renders recalled fragments as a single prose block the engine writes onto
 * the blackboard before round 1. Agents see this under a `## Memory` heading
 * in their prompt header — explicitly tagged as "past decisions" so the
 * Skeptic neurotype can challenge stale entries naturally.
 */
export function formatMemoryFragments(fragments: MemoryFragment[]): string {
  if (fragments.length === 0) return '';
  const lines = [`${fragments.length} related past decision${fragments.length === 1 ? '' : 's'}:`];
  for (const fragment of fragments) {
    const date = fragment.createdAt.slice(0, 10);
    const preview = fragment.content.replace(/\s+/g, ' ').trim();
    lines.push(`- ${date}: ${preview}`);
  }
  return lines.join('\n');
}
