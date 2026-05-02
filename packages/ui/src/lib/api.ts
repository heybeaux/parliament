import type {
  DeliberationCreated,
  DeliberationResult,
  DeliberationSummary,
  PresetsResponse,
  TranscriptFile,
} from './types';

const BASE = '/api';

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);
  }
  return (await res.json()) as T;
}

export interface DeliberateOptions {
  maxRounds?: number;
  redAgentInterval?: number;
  confidenceThreshold?: number;
}

export async function startDeliberation(
  topic: string,
  options?: {
    preset?: string;
    /**
     * PAR-16: optional free-form prose context. When non-empty, included
     * as the `context` field on the POST body so the engine prepends it
     * to every agent's user message. The legacy inline `CONTEXT:` marker
     * in the topic still works for back-compat but is deprecated.
     */
    context?: string;
    config?: DeliberateOptions;
  },
  signal?: AbortSignal,
): Promise<DeliberationCreated> {
  const preset = options?.preset?.trim();
  const context = options?.context?.trim();
  const config = options?.config;
  const res = await fetch(`${BASE}/deliberate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      topic,
      ...(preset ? { preset } : {}),
      ...(context ? { context } : {}),
      ...(config ? { config } : {}),
    }),
    signal,
  });
  return jsonOrThrow<DeliberationCreated>(res);
}

/**
 * Fetch the topology preset registry from the server.
 *
 * The server returns `{ presets, defaultPreset }`. Callers should provide a
 * fallback list when this rejects so the form remains usable if the endpoint
 * is unavailable (network error, 404 on older servers, etc.).
 */
export async function getPresets(signal?: AbortSignal): Promise<PresetsResponse> {
  const res = await fetch(`${BASE}/presets`, { signal });
  return jsonOrThrow<PresetsResponse>(res);
}

export async function getDeliberation(id: string): Promise<DeliberationResult> {
  const res = await fetch(`${BASE}/deliberate/${encodeURIComponent(id)}`);
  return jsonOrThrow<DeliberationResult>(res);
}

export async function listDeliberations(): Promise<DeliberationSummary[]> {
  const res = await fetch(`${BASE}/deliberations`);
  const body = await jsonOrThrow<{ deliberations: DeliberationSummary[] }>(res);
  return body.deliberations;
}

export async function listTranscripts(): Promise<TranscriptFile[]> {
  const res = await fetch(`${BASE}/transcripts`);
  const body = await jsonOrThrow<{ transcripts: TranscriptFile[] }>(res);
  return body.transcripts;
}

export async function getTranscript(file: string): Promise<DeliberationResult> {
  const res = await fetch(`${BASE}/transcripts/${encodeURIComponent(file)}`);
  const raw = await jsonOrThrow<Record<string, unknown>>(res);
  // Transcript files use snake_case; normalize to camelCase for the UI.
  const fallbackTimestamp = (raw['created_at'] ?? '') as string;
  return {
    topic: raw['topic'] as string,
    turns: raw['turns'] as DeliberationResult['turns'],
    conflicts: (raw['conflicts'] ?? []) as DeliberationResult['conflicts'],
    residueScore: (raw['residue'] ?? raw['residueScore'] ?? 0) as number,
    resolved: Boolean(raw['resolved']),
    synthesis: (raw['synthesis'] ?? null) as string | null,
    split: (raw['split'] ?? null) as DeliberationResult['split'],
    terminationReason: (raw['termination_reason'] ?? raw['terminationReason'] ?? 'max_rounds') as DeliberationResult['terminationReason'],
    totalRounds: (raw['total_rounds'] ?? raw['totalRounds'] ?? 0) as number,
    started_at: (raw['started_at'] ?? fallbackTimestamp) as string,
    completed_at: (raw['completed_at'] ?? fallbackTimestamp) as string,
    events: (raw['events'] ?? []) as DeliberationResult['events'],
  };
}

export interface HealthResponse {
  status: string;
  models: Record<string, 'connected' | 'unreachable'>;
}

export async function getHealth(): Promise<HealthResponse> {
  const res = await fetch(`${BASE}/health`);
  return jsonOrThrow<HealthResponse>(res);
}
