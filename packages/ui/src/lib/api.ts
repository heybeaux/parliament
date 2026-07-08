import type {
  DeliberationAccepted,
  DeliberationResult,
  DeliberationSource,
  DeliberationSummary,
  PresetsResponse,
  TranscriptFile,
} from './types';

const BASE = (import.meta.env.VITE_PARLIAMENT_API ?? '') + '/api';

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
  /**
   * PAR-17 — per-source word cap. When set, overrides the engine's 500-word
   * default applied during prompt construction.
   */
  maxSourceWords?: number;
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
    /**
     * PAR-17: optional structured sources. When non-empty, included as the
     * `sources` field on the POST body so the engine renders a `## Sources`
     * block on every non-Sentry agent's user prompt and the Empiricist
     * activates evidence-backed claim mode. Caller is responsible for
     * pre-extracting `content` (no on-demand retrieval in the engine).
     */
    sources?: DeliberationSource[];
    config?: DeliberateOptions;
  },
  signal?: AbortSignal,
): Promise<DeliberationAccepted> {
  const preset = options?.preset?.trim();
  const context = options?.context?.trim();
  const sources = options?.sources;
  const config = options?.config;
  const res = await fetch(`${BASE}/deliberate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      topic,
      ...(preset ? { preset } : {}),
      ...(context ? { context } : {}),
      ...(sources && sources.length > 0 ? { sources } : {}),
      ...(config ? { config } : {}),
    }),
    signal,
  });
  // PAR-18: server now returns 202 Accepted with `{id, status: 'in_flight'}`
  // immediately and runs the engine in the background. The full
  // `DeliberationResult` is no longer in this response — callers must
  // either open the SSE stream (PAR-26) or poll `GET /deliberate/:id`.
  return jsonOrThrow<DeliberationAccepted>(res);
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
  const result: DeliberationResult = {
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
  // PAR-17 — round-trip optional sources from the transcript file when present.
  if (Array.isArray(raw['sources']) && raw['sources'].length > 0) {
    result.sources = raw['sources'] as DeliberationResult['sources'];
  }
  return result;
}

export interface HealthResponse {
  status: string;
  models: Record<string, 'connected' | 'unreachable'>;
}

export async function getHealth(): Promise<HealthResponse> {
  const res = await fetch(`${BASE}/health`);
  return jsonOrThrow<HealthResponse>(res);
}

/** The five roles whose models can be overridden from Settings. */
export type ModelRole = 'proposer' | 'skeptic' | 'synthesizer' | 'redAgent' | 'sentry';

export const MODEL_ROLES: ModelRole[] = [
  'proposer',
  'skeptic',
  'synthesizer',
  'redAgent',
  'sentry',
];

/** Per-role model status: TOML default, effective model, override flag. */
export interface RoleModelStatus {
  default: string | null;
  effective: string | null;
  override_active: boolean;
}

export interface SettingsStatus {
  provider: string;
  openrouter_key_configured: boolean;
  openrouter_key_hint: string | null;
  key_source: 'env' | 'file' | null;
  /** Absent on pre-model-picker servers — treat as "section unavailable". */
  models?: Record<ModelRole, RoleModelStatus>;
}

export async function getSettings(): Promise<SettingsStatus> {
  const res = await fetch(`${BASE}/settings`);
  return jsonOrThrow<SettingsStatus>(res);
}

export async function saveOpenRouterKey(key: string): Promise<SettingsStatus> {
  const res = await fetch(`${BASE}/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ openrouter_api_key: key }),
  });
  return jsonOrThrow<SettingsStatus>(res);
}

export interface ModelCatalogEntry {
  id: string;
  name: string;
}

/**
 * Server-side proxy of OpenRouter's public model catalog. The webview must
 * not call openrouter.ai directly (its origin is tauri://localhost and the
 * catalog endpoint won't grant it CORS), so the sidecar fetches and caches it.
 */
export async function getModelCatalog(): Promise<ModelCatalogEntry[]> {
  const res = await fetch(`${BASE}/models`);
  const body = await jsonOrThrow<{ models: ModelCatalogEntry[] }>(res);
  return body.models;
}

/**
 * Persist per-role model overrides. A string sets the override, `null`
 * clears it back to the config default, an absent role is left untouched.
 * Returns the updated per-role status map.
 */
export async function saveModelOverrides(
  overrides: Partial<Record<ModelRole, string | null>>,
): Promise<Record<ModelRole, RoleModelStatus>> {
  const res = await fetch(`${BASE}/settings/models`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model_overrides: overrides }),
  });
  const body = await jsonOrThrow<{ ok: boolean; models: Record<ModelRole, RoleModelStatus> }>(res);
  return body.models;
}
