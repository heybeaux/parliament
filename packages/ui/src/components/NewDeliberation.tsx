import { useState } from 'react';
import { motion } from 'framer-motion';
import { PresetPicker, FALLBACK_DEFAULT } from './PresetPicker';
import { SampleQuestions } from './SampleQuestions';
import type { SampleQuestion } from '../lib/sampleQuestions';

interface Props {
  /**
   * Submit callback. The third argument is the optional PAR-16 prose context
   * — `undefined` when the textarea is empty (or never expanded), otherwise
   * the trimmed contents. Older callers that only handle (topic, preset)
   * keep working unchanged because the parameter is optional in the
   * function-type sense (extra args are ignored in JS).
   */
  onSubmit: (topic: string, preset: string, context?: string) => void;
  disabled: boolean;
}

export function NewDeliberation({ onSubmit, disabled }: Props) {
  const [topic, setTopic] = useState('');
  const [preset, setPreset] = useState<string>(FALLBACK_DEFAULT);
  const [focused, setFocused] = useState(false);
  // PAR-16: optional prose context. Mirrors the PresetPicker pattern —
  // collapsible-by-default, controlled, empty-string when unused. We model
  // both an `expanded` flag and a `context` string so re-collapsing the
  // panel does not nuke whatever the user has typed.
  const [contextExpanded, setContextExpanded] = useState(false);
  const [context, setContext] = useState('');

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = topic.trim();
    if (!trimmed || disabled) return;
    const trimmedContext = context.trim();
    onSubmit(
      trimmed,
      preset,
      trimmedContext.length > 0 ? trimmedContext : undefined,
    );
    setTopic('');
    setContext('');
    setContextExpanded(false);
  }

  function handlePickSample(sample: SampleQuestion) {
    if (disabled) return;
    setTopic(sample.topic);
    setPreset(sample.presetId);
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
            {/* PAR-16: collapsible context disclosure handled below. */}

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

          {/*
            PAR-16: optional collapsible context.

            Mirrors the PresetPicker pattern (controlled component, included
            in submit when non-empty). Default collapsed so the form stays
            uncluttered for the simple-question case; users with a real brief
            click "Add context" and paste it into the textarea. The trimmed
            contents are forwarded verbatim by `handleSubmit` to the engine.
          */}
          <div className="mt-3">
            {!contextExpanded ? (
              <button
                type="button"
                onClick={() => setContextExpanded(true)}
                disabled={disabled}
                aria-expanded={false}
                aria-controls="deliberation-context"
                className="flex items-center gap-2 rounded-lg px-2 py-1 text-xs font-medium uppercase tracking-widest text-zinc-400 transition-colors hover:text-zinc-200 disabled:opacity-40"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round"/>
                </svg>
                Add context
              </button>
            ) : (
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <label
                    htmlFor="deliberation-context"
                    className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-zinc-400"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="text-parliament-400" aria-hidden="true">
                      <path d="M4 6h16M4 12h10M4 18h7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                    </svg>
                    Context
                  </label>
                  <button
                    type="button"
                    onClick={() => setContextExpanded(false)}
                    aria-expanded={true}
                    aria-controls="deliberation-context"
                    className="text-2xs uppercase tracking-wider text-zinc-500 transition-colors hover:text-zinc-200"
                  >
                    Hide
                  </button>
                </div>
                <textarea
                  id="deliberation-context"
                  aria-label="Deliberation context"
                  value={context}
                  onChange={(e) => setContext(e.target.value)}
                  disabled={disabled}
                  rows={5}
                  placeholder="Paste a background brief, design doc excerpt, or system description here. Each agent sees it under a stable '## Background' heading."
                  className="w-full resize-y rounded-xl border-0 bg-white/[0.03] px-4 py-3 text-sm text-zinc-100 placeholder-zinc-500/70 outline-none ring-1 ring-white/[0.06] transition-colors focus:bg-white/[0.05] focus:ring-parliament-400/30 disabled:opacity-40"
                />
                <p className="text-2xs text-zinc-500">
                  Optional. The legacy inline <code>CONTEXT:</code> marker in the topic still works but is deprecated.
                </p>
              </div>
            )}
          </div>

          <SampleQuestions onPick={handlePickSample} disabled={disabled} />
        </div>
      </div>
    </motion.form>
  );
}
