import { useEffect, useState } from 'react';
import {
  MODEL_ROLES,
  getModelCatalog,
  getSettings,
  saveModelOverrides,
  saveOpenRouterKey,
  type ModelCatalogEntry,
  type ModelRole,
  type SettingsStatus,
} from '../lib/api';

interface SettingsPanelProps {
  open: boolean;
  onClose: () => void;
  /** Called after a successful save so the parent can re-check health. */
  onSaved?: () => void;
}

const ROLE_LABELS: Record<ModelRole, string> = {
  proposer: 'Proposer',
  skeptic: 'Skeptic',
  synthesizer: 'Synthesizer',
  redAgent: 'Red Agent',
  sentry: 'Sentry',
};

function seedDraft(models: SettingsStatus['models']): Partial<Record<ModelRole, string>> {
  const draft: Partial<Record<ModelRole, string>> = {};
  if (!models) return draft;
  for (const role of MODEL_ROLES) {
    draft[role] = models[role]?.effective ?? '';
  }
  return draft;
}

/**
 * First-run / settings modal. The only thing a desktop user must configure is
 * their OpenRouter API key — paste it, save, and the server applies it live
 * (no restart) so the health bar flips to connected on the next probe.
 *
 * The Models section lets the user swap which OpenRouter model plays each
 * role. Options come from the server's `/api/models` proxy (the webview can't
 * call openrouter.ai directly — CORS); when that fetch fails the picker
 * degrades to a free-text input so power users can still type a model id.
 */
export function SettingsPanel({ open, onClose, onSaved }: SettingsPanelProps) {
  const [status, setStatus] = useState<SettingsStatus | null>(null);
  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedOk, setSavedOk] = useState(false);

  const [catalog, setCatalog] = useState<ModelCatalogEntry[] | null>(null);
  const [catalogFailed, setCatalogFailed] = useState(false);
  const [draft, setDraft] = useState<Partial<Record<ModelRole, string>>>({});
  const [modelsSaving, setModelsSaving] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [modelsSavedOk, setModelsSavedOk] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setSavedOk(false);
    setModelsError(null);
    setModelsSavedOk(false);
    getSettings()
      .then((s) => {
        setStatus(s);
        setDraft(seedDraft(s.models));
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    getModelCatalog()
      .then((models) => {
        setCatalog(models);
        setCatalogFailed(false);
      })
      .catch(() => {
        setCatalog(null);
        setCatalogFailed(true);
      });
  }, [open]);

  if (!open) return null;

  async function handleSave() {
    const trimmed = key.trim();
    if (!trimmed) {
      setError('Paste your OpenRouter API key first.');
      return;
    }
    setSaving(true);
    setError(null);
    setSavedOk(false);
    try {
      const next = await saveOpenRouterKey(trimmed);
      setStatus(next);
      setKey('');
      setSavedOk(true);
      onSaved?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveModels() {
    const roleModels = status?.models;
    if (!roleModels) return;
    setModelsSaving(true);
    setModelsError(null);
    setModelsSavedOk(false);
    try {
      // Draft equal to the config default (or blank) clears the override;
      // anything else sets it.
      const patch: Partial<Record<ModelRole, string | null>> = {};
      for (const role of MODEL_ROLES) {
        const value = (draft[role] ?? '').trim();
        patch[role] = value.length === 0 || value === roleModels[role]?.default ? null : value;
      }
      const models = await saveModelOverrides(patch);
      setStatus((s) => (s ? { ...s, models } : s));
      setDraft(seedDraft(models));
      setModelsSavedOk(true);
      onSaved?.();
    } catch (e) {
      setModelsError(e instanceof Error ? e.message : String(e));
    } finally {
      setModelsSaving(false);
    }
  }

  function resetAllModels() {
    const roleModels = status?.models;
    if (!roleModels) return;
    const next: Partial<Record<ModelRole, string>> = {};
    for (const role of MODEL_ROLES) {
      next[role] = roleModels[role]?.default ?? '';
    }
    setDraft(next);
    setModelsSavedOk(false);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      onClick={onClose}
    >
      <div
        className="glass glass-border max-h-[85vh] w-full max-w-md overflow-y-auto rounded-2xl p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold text-zinc-100">Settings</h2>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-200"
            aria-label="Close settings"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label htmlFor="openrouter-key" className="mb-1.5 block text-sm font-medium text-zinc-200">
              OpenRouter API Key
            </label>
            <p className="mb-2 text-xs leading-relaxed text-zinc-500">
              Parliament runs every agent through OpenRouter. Paste your key to
              connect. Get one at{' '}
              <span className="text-parliament-400">openrouter.ai/keys</span>.
            </p>

            {status?.openrouter_key_configured ? (
              <div className="mb-2 flex items-center gap-2 rounded-lg bg-emerald-500/10 px-3 py-2 ring-1 ring-emerald-400/20">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                <span className="text-xs text-emerald-300">
                  Key configured ({status.openrouter_key_hint})
                  {status.key_source === 'env' ? ' — from environment' : ''}
                </span>
              </div>
            ) : (
              <div className="mb-2 flex items-center gap-2 rounded-lg bg-amber-500/10 px-3 py-2 ring-1 ring-amber-400/20">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                <span className="text-xs text-amber-300">No key configured yet</span>
              </div>
            )}

            <input
              id="openrouter-key"
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="sk-or-v1-..."
              autoComplete="off"
              spellCheck={false}
              className="w-full rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 outline-none focus:border-parliament-400/40 focus:ring-1 focus:ring-parliament-400/30"
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleSave();
              }}
            />
          </div>

          {error && (
            <p className="text-xs text-rose-300" role="alert">
              {error}
            </p>
          )}
          {savedOk && !error && (
            <p className="text-xs text-emerald-300">
              Saved. Connecting agents…
            </p>
          )}

          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving}
            className="w-full rounded-lg bg-parliament-500/90 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-parliament-500 disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save key'}
          </button>

          {status?.models && (
            <div className="border-t border-white/[0.06] pt-4">
              <div className="mb-1.5 flex items-center justify-between">
                <h3 className="text-sm font-medium text-zinc-200">Models</h3>
                <button
                  type="button"
                  onClick={resetAllModels}
                  className="text-xs text-zinc-500 transition-colors hover:text-zinc-300"
                >
                  Reset all to defaults
                </button>
              </div>
              <p className="mb-3 text-xs leading-relaxed text-zinc-500">
                Choose which OpenRouter model plays each role. Changes apply to
                the next deliberation.
              </p>

              <div className="space-y-2.5">
                {MODEL_ROLES.map((role) => {
                  const info = status.models?.[role];
                  const value = draft[role] ?? '';
                  const inCatalog =
                    catalog !== null && catalog.some((m) => m.id === value);
                  const isOverride =
                    Boolean(value) && info?.default != null && value !== info.default;
                  return (
                    <div key={role}>
                      <div className="mb-1 flex items-center justify-between">
                        <label
                          htmlFor={`model-${role}`}
                          className="text-xs font-medium text-zinc-300"
                        >
                          {ROLE_LABELS[role]}
                          {isOverride && (
                            <span className="ml-1.5 rounded-md bg-parliament-500/10 px-1.5 py-0.5 text-2xs font-semibold text-parliament-400 ring-1 ring-parliament-400/20">
                              custom
                            </span>
                          )}
                        </label>
                        {isOverride && (
                          <button
                            type="button"
                            onClick={() => {
                              setDraft((d) => ({ ...d, [role]: info?.default ?? '' }));
                              setModelsSavedOk(false);
                            }}
                            className="text-2xs text-zinc-500 transition-colors hover:text-zinc-300"
                          >
                            Reset to default
                          </button>
                        )}
                      </div>
                      {catalog !== null && !catalogFailed ? (
                        <select
                          id={`model-${role}`}
                          value={value}
                          onChange={(e) => {
                            setDraft((d) => ({ ...d, [role]: e.target.value }));
                            setModelsSavedOk(false);
                          }}
                          className="w-full rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-zinc-100 outline-none focus:border-parliament-400/40 focus:ring-1 focus:ring-parliament-400/30 [&>option]:bg-zinc-900"
                        >
                          {/* A configured model missing from the catalog (e.g.
                              delisted upstream) still renders — flagged so the
                              user knows why deliberations may fail. */}
                          {value && !inCatalog && (
                            <option value={value}>{value} (not available)</option>
                          )}
                          {catalog.map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.name}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          id={`model-${role}`}
                          type="text"
                          value={value}
                          onChange={(e) => {
                            setDraft((d) => ({ ...d, [role]: e.target.value }));
                            setModelsSavedOk(false);
                          }}
                          placeholder="provider/model-id"
                          autoComplete="off"
                          spellCheck={false}
                          className="w-full rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 outline-none focus:border-parliament-400/40 focus:ring-1 focus:ring-parliament-400/30"
                        />
                      )}
                    </div>
                  );
                })}
              </div>

              {catalogFailed && (
                <p className="mt-2 text-2xs text-zinc-500">
                  Couldn’t load the model list — type an OpenRouter model id
                  (e.g. openai/gpt-5-mini).
                </p>
              )}

              {modelsError && (
                <p className="mt-3 text-xs text-rose-300" role="alert">
                  {modelsError}
                </p>
              )}
              {modelsSavedOk && !modelsError && (
                <p className="mt-3 text-xs text-emerald-300">
                  Models saved. They’ll be used on the next deliberation.
                </p>
              )}

              <button
                type="button"
                onClick={() => void handleSaveModels()}
                disabled={modelsSaving}
                className="mt-3 w-full rounded-lg bg-parliament-500/90 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-parliament-500 disabled:opacity-50"
              >
                {modelsSaving ? 'Saving…' : 'Save models'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
