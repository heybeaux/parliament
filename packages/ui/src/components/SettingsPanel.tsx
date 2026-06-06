import { useEffect, useState } from 'react';
import { getSettings, saveOpenRouterKey, type SettingsStatus } from '../lib/api';

interface SettingsPanelProps {
  open: boolean;
  onClose: () => void;
  /** Called after a successful save so the parent can re-check health. */
  onSaved?: () => void;
}

/**
 * First-run / settings modal. The only thing a desktop user must configure is
 * their OpenRouter API key — paste it, save, and the server applies it live
 * (no restart) so the health bar flips to connected on the next probe.
 */
export function SettingsPanel({ open, onClose, onSaved }: SettingsPanelProps) {
  const [status, setStatus] = useState<SettingsStatus | null>(null);
  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedOk, setSavedOk] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setSavedOk(false);
    getSettings()
      .then(setStatus)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
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

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      onClick={onClose}
    >
      <div
        className="glass glass-border w-full max-w-md rounded-2xl p-6"
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
        </div>
      </div>
    </div>
  );
}
