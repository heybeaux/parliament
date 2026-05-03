/**
 * Curated sample questions per built-in preset.
 *
 * Sourced from the 2026-05-02 frontier-lineup sample run published at
 * `heybeaux/ops/research/parliament-deliberations/`. Each entry pairs the
 * preset id with a topic that exercises the preset's strength so a new user
 * can pick a "Try this question" affordance and see what the preset is for
 * without having to read the docs first.
 *
 * `transcript_url` points at the rendered markdown for that preset's full
 * sample run on the open-frontier lineup.
 */
export interface SampleQuestion {
  presetId: string;
  topic: string;
  why_fits: string;
  /**
   * Optional — link to a published full transcript. Presets without a
   * canonical sample run yet (e.g. newly-added presets) omit this and the
   * card hides the "View full transcript" link.
   */
  transcript_url?: string;
}

const TRANSCRIPT_BASE =
  'https://github.com/heybeaux/ops/blob/main/research/parliament-deliberations/2026-05-02-preset-';

export const SAMPLE_QUESTIONS: SampleQuestion[] = [
  {
    presetId: 'debate',
    topic:
      'Should we add a 4th LLM family to our adapter pool, or consolidate down to two?',
    why_fits:
      'Focused operational tradeoff with two clear sides — Debate converges quickly without burning rounds on perspective-gathering.',
    transcript_url: `${TRANSCRIPT_BASE}debate.md`,
  },
  {
    presetId: 'star-chamber',
    topic:
      'Claim: pgvector is sufficient for production RAG workloads at small-to-medium scale; a dedicated vector DB (Pinecone, Weaviate, Qdrant) is operational overhead without payoff.',
    why_fits:
      'Single concrete proposal that benefits from multiple critique angles firing in turn — Skeptic for logic, Devils-Advocate for adversarial framing, Empiricist for evidence.',
    transcript_url: `${TRANSCRIPT_BASE}star-chamber.md`,
  },
  {
    presetId: 'chain-of-verifiers',
    topic:
      'Factual claim: most software-engineering productivity gains observed in 2026 came from agentic coding tools, not from foundation-model scaling.',
    why_fits:
      'Empirical claim where the natural review order is evidence → charitable restatement → logical scrutiny — exactly what Chain-of-Verifiers enforces.',
    transcript_url: `${TRANSCRIPT_BASE}chain-of-verifiers.md`,
  },
  {
    presetId: 'socratic',
    topic:
      "I think we should adopt event sourcing for our user service. Help me figure out whether that's actually the right call.",
    why_fits:
      "User wants their OWN claim dissected, not a thesis defended — Socratic surfaces hidden assumptions in the user's framing before applying scrutiny.",
    transcript_url: `${TRANSCRIPT_BASE}socratic.md`,
  },
  {
    presetId: 'long-view',
    topic:
      'Should startups in 2026 plan for a regulatory crackdown on autonomous-agent deployment within the next three years?',
    why_fits:
      'Strategic question with explicit temporal axes — needs Historian (past regulatory cycles), Forecaster (3-year projection), and Pragmatist (what is actionable now).',
    transcript_url: `${TRANSCRIPT_BASE}long-view.md`,
  },
  {
    presetId: 'reframe',
    topic: 'Our team is shipping too slowly.',
    why_fits:
      'The framing itself feels wrong but the user cannot articulate why — Reframe surfaces alternative framings (analogy, hidden assumptions, charitable opposing case) before any critique commits.',
    transcript_url: `${TRANSCRIPT_BASE}reframe.md`,
  },
  {
    presetId: 'jury',
    topic:
      'Should our engineering org default to LLM-generated code-review comments on every pull request?',
    why_fits:
      'Multiple independent critique angles need to fire without contaminating each other — Jury runs the four critics in parallel against the same blackboard so the first speaker does not dominate.',
    transcript_url: `${TRANSCRIPT_BASE}jury.md`,
  },
  {
    presetId: 'adversarial',
    topic:
      'We want to add streaming SSE responses to our agent API so the UI can render turns as they land. Should this be the next feature we ship?',
    why_fits:
      'New-feature decision where the interesting answer is what breaks first when this ships — failure modes (head-of-line blocking, proxy buffering, reconnection storms), hidden costs (debugging async streams, on-call surface), and exploitable assumptions about client retry behavior.',
  },
];

export const SAMPLE_QUESTION_BY_PRESET = new Map(
  SAMPLE_QUESTIONS.map((q) => [q.presetId, q]),
);
