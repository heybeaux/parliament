export type {
  Turn,
  Conflict,
  Blackboard,
  DebateResult,
  DeliberationResult,
  SplitSummary,
  TerminationReason,
  SentrySignal,
} from './types.js';

export type { ModelAdapter } from './adapters/base.js';
export { ModelConnectionError } from './adapters/base.js';
export { OllamaAdapter } from './adapters/ollama.js';
export { OpenAICompatAdapter } from './adapters/openai-compat.js';
export { LMStudioAdapter } from './adapters/lm-studio.js';
export { OMLXAdapter } from './adapters/omlx.js';
export { createAdapter } from './adapters/provider-factory.js';

export type {
  NeurotypeConfig,
  ParliamentTomlConfig,
  ParliamentDefaults,
} from './config.js';
export {
  loadConfig,
  resolveConfigPath,
  getConfig,
  getNeurotype,
  resetConfigCache,
  buildAgentsFromConfig,
  DEFAULT_PARLIAMENT_DEFAULTS,
} from './config.js';

export {
  topicSlug,
  formatTimestamp,
  saveTranscript,
  formatTurnHeader,
  printTurn,
  printSummary,
} from './transcript.js';

export type { AgentDefinition, DebateOptions } from './debate.js';
export { runDebate } from './debate.js';

export type { Agent, AgentResult, SynthesizerResult, SentryResult } from './agents/index.js';
export {
  ProposerAgent,
  SkepticAgent,
  SynthesizerAgent,
  RedAgent,
  SentryAgent,
  enforceWordCap,
  jaccardSimilarity,
} from './agents/index.js';

export type { DeliberationConfig } from './engine.js';
export { DeliberationEngine } from './engine.js';

export type { ScheduledTurn, BatchSchedule } from './scheduler/index.js';
export { buildBatchSchedule, countModelSwaps } from './scheduler/index.js';

export {
  computeOSI,
  detectEchoLoop,
  OSI_CONVERGENCE_THRESHOLD,
} from './osi.js';
