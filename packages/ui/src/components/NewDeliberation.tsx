import { useState } from 'react';
import { motion } from 'framer-motion';
import { PresetPicker, FALLBACK_DEFAULT } from './PresetPicker';

interface Props {
  onSubmit: (topic: string, preset: string) => void;
  disabled: boolean;
}

export function NewDeliberation({ onSubmit, disabled }: Props) {
  const [topic, setTopic] = useState('');
  const [preset, setPreset] = useState<string>(FALLBACK_DEFAULT);
  const [focused, setFocused] = useState(false);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = topic.trim();
    if (!trimmed || disabled) return;
    onSubmit(trimmed, preset);
    setTopic('');
  }

  return (
    <motion.form
      onSubmit={handleSubmit}
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: 'easeOut' }}
      className="relative"
    >
      <div
        className={`relative overflow-hidden rounded-2xl transition-all duration-300 ${
          focused
            ? 'ring-2 ring-parliament-400/30 shadow-glow'
            : 'ring-1 ring-white/[0.06]'
        }`}
      >
        {/* Subtle gradient top border */}
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-parliament-400/30 to-transparent" />

        <div className="surface p-5 !border-0">
          <label className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-zinc-400">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="text-parliament-400">
              <path d="M12 2v4m0 12v4M4.93 4.93l2.83 2.83m8.48 8.48l2.83 2.83M2 12h4m12 0h4M4.93 19.07l2.83-2.83m8.48-8.48l2.83-2.83" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
            New deliberation
          </label>

          <div className="mb-4">
            <PresetPicker value={preset} onChange={setPreset} disabled={disabled} />
          </div>

          <div className="flex flex-col gap-3 sm:flex-row">
            <div className="relative flex-1">
              <input
                type="text"
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                placeholder="Should an autonomous AI ever take irreversible actions?"
                disabled={disabled}
                className="w-full rounded-xl border-0 bg-white/[0.03] px-4 py-3 text-sm text-zinc-100 placeholder-zinc-500/70 outline-none transition-colors focus:bg-white/[0.05] disabled:opacity-40"
              />
            </div>

            <button
              type="submit"
              disabled={disabled || topic.trim().length === 0}
              className="group relative overflow-hidden rounded-xl px-6 py-3 text-sm font-medium shadow-md transition-all disabled:opacity-30 disabled:shadow-none sm:shrink-0"
            >
              {/* Button gradient background */}
              <div className="absolute inset-0 bg-gradient-to-r from-parliament-500 to-parliament-400 transition-opacity group-hover:opacity-90 group-disabled:opacity-50" />
              <div className="absolute inset-0 bg-gradient-to-r from-parliament-400 to-amber-400 opacity-0 transition-opacity group-hover:opacity-100 group-disabled:opacity-0" />

              <span className="relative flex items-center justify-center gap-2 text-ink-900 font-semibold">
                {disabled ? (
                  <>
                    <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3"/>
                      <path className="opacity-75" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" fill="currentColor"/>
                    </svg>
                    Running
                  </>
                ) : (
                  <>
                    Deliberate
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="transition-transform group-hover:translate-x-0.5">
                      <path d="M5 12h14m-6-6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </>
                )}
              </span>
            </button>
          </div>
        </div>
      </div>
    </motion.form>
  );
}
