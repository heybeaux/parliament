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

/**
 * Engram's recall response shape, matching the live API as of the pinned
 * spec at integrations/engram/PIN.md. The `memories[].raw` field is the
 * canonical content string; older Engram builds returned `content`/`text`
 * — those are still accepted as fallbacks so a partial backend rollout
 * doesn't break Parliament.
 */
interface EngramRecallResponse {
  memories?: Array<{
    id?: string;
    raw?: string;
    content?: string;
    text?: string;
    layer?: string;
    score?: number;
    createdAt?: string;
    created_at?: string;
  }>;
  recallId?: string;
  queryTokens?: number;
  latencyMs?: number;
}

/**
 * Adapter for the Engram HTTP API. Maps `recall` →
 * `POST /v1/memories/query?agentId=<id>` and `remember` →
 * `POST /v1/memories` with `x-am-agent-id`. Authenticates with the
 * `X-AM-API-Key` header (per the OpenAPI spec at
 * `integrations/engram/api-spec.json`).
 *
 * Contract notes (see integrations/engram/PIN.md for the full pin record):
 * - `agentId` is a required query-string parameter on recall, NOT a header.
 * - `X-AM-API-Key` is the auth header. Bearer auth is reserved for JWTs.
 * - Recall response is `{ memories: [{ raw, ... }] }`, not `{ results }`.
 * - `INSIGHT` is a runtime-valid layer even though the spec omits it; we
 *   write deliberation outcomes to it.
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
    const url = `${this.endpoint}/v1/memories/query?agentId=${encodeURIComponent(opts.agentId)}`;
    const res = await this.fetchImpl(url, {
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
    const memories = body.memories ?? [];
    return memories
      .filter((m) => typeof (m.raw ?? m.content ?? m.text) === 'string')
      .map((m) => ({
        id: typeof m.id === 'string' ? m.id : '',
        content: (m.raw ?? m.content ?? m.text ?? '').trim(),
        layer: this.normalizeLayer(m.layer),
        score: typeof m.score === 'number' ? m.score : 0,
        createdAt:
          typeof m.createdAt === 'string'
            ? m.createdAt
            : typeof m.created_at === 'string'
              ? m.created_at
              : this.now().toISOString(),
      }));
  }

  async remember(outcome: MemoryOutcome, opts: RememberOptions): Promise<void> {
    const summary = formatOutcomeForMemory(outcome);
    const res = await this.fetchImpl(`${this.endpoint}/v1/memories`, {
      method: 'POST',
      headers: this.buildHeaders(opts.agentId),
      body: JSON.stringify({
        raw: summary,
        layer: 'INSIGHT',
        source: 'AGENT_REFLECTION',
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
      headers['x-am-api-key'] = this.apiKey;
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
 *
 * Past-tense, plain-English framing matters here. PAR-43 surfaced that the
 * earlier status-line format ("max_rounds after 2 rounds (residue 1.00)")
 * read like a *system invariant on the current run* to the Skeptic agent —
 * it called the new deliberation "logically invalid within the system
 * state" because it confused a historical termination reason for a live
 * procedural cap. The prose below tells the agent what *happened* (past),
 * not what *is* (present), and translates the enum + numeric residue into
 * language the agent reads as context rather than constraint.
 */
export function formatOutcomeForMemory(outcome: MemoryOutcome): string {
  const lines = [
    `Topic: ${outcome.topic}`,
    `Previously deliberated: ${describeTerminationOutcome(
      outcome.terminationReason,
      outcome.totalRounds,
      outcome.residueScore,
    )}`,
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
 * Maps a `MemoryOutcome.terminationReason` + round count + residue score to
 * a single past-tense sentence describing what happened in the prior debate.
 * Unrecognized termination reasons fall through to a generic "ended" phrasing
 * so the agent still sees coherent prose if the enum grows.
 */
function describeTerminationOutcome(
  terminationReason: string,
  totalRounds: number,
  residueScore: number,
): string {
  const roundWord = totalRounds === 1 ? 'round' : 'rounds';
  const residueQualifier = describeResidue(residueScore);
  switch (terminationReason) {
    case 'consensus':
      return `the agents reached consensus after ${totalRounds} ${roundWord}${residueQualifier}.`;
    case 'max_rounds':
      return `the debate ended without consensus after ${totalRounds} ${roundWord} (the round budget was reached)${residueQualifier}.`;
    case 'echo_loop':
      return `the debate was halted after ${totalRounds} ${roundWord} because the agents had begun looping without making progress${residueQualifier}.`;
    case 'red_agent_triggered':
      return `a red-agent intervention was triggered after ${totalRounds} ${roundWord} to break premature convergence${residueQualifier}.`;
    default:
      return `the debate ended (reason: ${terminationReason}) after ${totalRounds} ${roundWord}${residueQualifier}.`;
  }
}

/**
 * Translates the numeric residue score into qualitative language the agent
 * doesn't have to interpret. The prefix is empty for "" (no qualifier
 * worth adding) — keep the overall sentence terse when residue is ambiguous.
 */
function describeResidue(residueScore: number): string {
  if (residueScore <= 0.2) return ' — the agents largely agreed';
  if (residueScore <= 0.5) return ' — significant points were resolved but some tensions remained';
  if (residueScore < 1) return ' — most points remained contested';
  return ' — the positions could not be reconciled';
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
