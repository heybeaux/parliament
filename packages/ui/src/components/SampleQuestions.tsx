import { useState } from 'react';
import { PresetBadge } from './PresetBadge';
import { SAMPLE_QUESTIONS, type SampleQuestion } from '../lib/sampleQuestions';

interface Props {
  /**
   * Apply the chosen sample to the parent form: fills the topic textbox and
   * sets the active preset. Parent owns both pieces of state.
   */
  onPick: (sample: SampleQuestion) => void;
  disabled?: boolean;
}

/**
 * Collapsible "Try a sample question" gallery.
 *
 * Surfaces the seven curated topics from the 2026-05-02 frontier-lineup
 * sample run so a new user can see, at a glance, what each preset is for
 * and how it shapes a transcript. Each card exposes:
 *
 * - the preset's color chip (matches PresetBadge identity used elsewhere)
 * - the sample topic (clicking the card or "Use this question" applies it
 *   to the parent form)
 * - a one-line "why this preset" rationale
 * - a link to the full rendered transcript on GitHub for users who want
 *   to read what a real run looks like before committing to one
 *
 * Default collapsed so the form stays uncluttered for users who already
 * know what they want to ask.
 */
export function SampleQuestions({ onPick, disabled = false }: Props) {
  const [expanded, setExpanded] = useState(false);

  if (!expanded) {
    return (
      <div className="mt-3">
        <button
          type="button"
          onClick={() => setExpanded(true)}
          disabled={disabled}
          aria-expanded={false}
          aria-controls="sample-questions-gallery"
          className="flex items-center gap-2 rounded-lg px-2 py-1 text-xs font-medium uppercase tracking-widest text-zinc-400 transition-colors hover:text-zinc-200 disabled:opacity-40"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M9 11l3 3 8-8M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          Try a sample question
        </button>
      </div>
    );
  }

  return (
    <div className="mt-3" id="sample-questions-gallery">
      <div className="mb-2 flex items-center justify-between">
        <label className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-zinc-400">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="text-parliament-400" aria-hidden="true">
            <path
              d="M9 11l3 3 8-8M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          Sample questions
        </label>
        <button
          type="button"
          onClick={() => setExpanded(false)}
          aria-expanded={true}
          aria-controls="sample-questions-gallery"
          className="text-2xs uppercase tracking-wider text-zinc-500 transition-colors hover:text-zinc-200"
        >
          Hide
        </button>
      </div>

      <p className="mb-3 text-2xs text-zinc-500">
        One curated example per preset, drawn from a real frontier-lineup run.
        Click a card to load the question into the form, or open the transcript
        to see what a complete deliberation looks like.
      </p>

      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {SAMPLE_QUESTIONS.map((sample) => (
          <li
            key={sample.presetId}
            className="group relative rounded-xl bg-white/[0.02] p-3 ring-1 ring-white/[0.06] transition-colors hover:bg-white/[0.04] hover:ring-white/[0.12]"
          >
            <button
              type="button"
              onClick={() => onPick(sample)}
              disabled={disabled}
              className="block w-full text-left disabled:opacity-40"
              aria-label={`Use the ${sample.presetId} sample question`}
            >
              <div className="mb-1.5 flex items-center gap-2">
                <PresetBadge presetId={sample.presetId} name={sample.presetId} />
              </div>
              <p className="mb-1.5 text-sm leading-snug text-zinc-200 line-clamp-3">
                {sample.topic}
              </p>
              <p className="text-2xs leading-relaxed text-zinc-500 line-clamp-2">
                {sample.why_fits}
              </p>
            </button>
            {sample.transcript_url && (
              <a
                href={sample.transcript_url}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 inline-flex items-center gap-1 text-2xs uppercase tracking-wider text-parliament-400 transition-colors hover:text-parliament-300"
                onClick={(e) => e.stopPropagation()}
              >
                View full transcript
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path
                    d="M14 3h7v7M21 3l-9 9M10 5H5a2 2 0 00-2 2v12a2 2 0 002 2h12a2 2 0 002-2v-5"
                    stroke="currentColor"
                    strokeWidth="1.75"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </a>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
