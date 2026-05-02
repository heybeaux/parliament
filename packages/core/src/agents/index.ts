export type { Agent, AgentResult } from './base.js';
export { ProposerAgent } from './proposer.js';
export { SkepticAgent } from './skeptic.js';
export type { SynthesizerResult } from './synthesizer.js';
export { SynthesizerAgent } from './synthesizer.js';
export { RedAgent } from './red-agent.js';
export type { SentryResult } from './sentry.js';
export { SentryAgent } from './sentry.js';
export { CONTEXT_HEADING, buildPromptHeader, enforceWordCap, jaccardSimilarity } from './utils.js';

// Stage 1 neurotype stubs — implementations land in per-agent tasks.
export { StubNeurotypeAgent } from './stub-agent.js';
export { HistorianAgent } from './historian.js';
export { ForecasterAgent } from './forecaster.js';
export { PragmatistAgent } from './pragmatist.js';
export { EmpiricistAgent } from './empiricist.js';
export { SteelmannerAgent } from './steelmanner.js';
export { DevilsAdvocateAgent } from './devils-advocate.js';
export { LateralistAgent } from './lateralist.js';
export { TranslatorAgent } from './translator.js';

// Built-in neurotype registry.
export type { AgentFactory } from './registry.js';
export {
  BUILTIN_AGENT_REGISTRY,
  BUILTIN_AGENT_IDS,
  isBuiltinNeurotype,
  createBuiltinAgent,
} from './registry.js';
