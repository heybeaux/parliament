export type {
  Turn,
  Conflict,
  Blackboard,
  DebateResult,
  DeliberationResult,
  DeliberationSource,
  DeliberationStatus,
  SplitSummary,
  SystemEvent,
  TerminationReason,
  SentrySignal,
} from './types.js';

export type {
  AdapterMeta,
  AdapterResult,
  ModelAdapter,
  UpstreamErrorContext,
} from './adapters/base.js';
export {
  ModelConnectionError,
  UpstreamProviderError,
  truncateUpstreamBody,
} from './adapters/base.js';
export { OllamaAdapter } from './adapters/ollama.js';
export { OpenAICompatAdapter } from './adapters/openai-compat.js';
export { LMStudioAdapter } from './adapters/lm-studio.js';
export { OMLXAdapter } from './adapters/omlx.js';
export {
  OpenRouterAdapter,
  type OpenRouterAdapterOptions,
} from './adapters/openrouter.js';
export { createAdapter } from './adapters/provider-factory.js';
export { Retrying5xxAdapter } from './adapters/retry.js';

export type {
  NeurotypeConfig,
  ParliamentTomlConfig,
  ParliamentDefaults,
  MemoryConfig,
  MemoryProviderKind,
  ContextConfig,
  ContextProviderKind,
} from './config.js';
export {
  loadConfig,
  loadTopologyConfig,
  resolveConfigPath,
  getConfig,
  getNeurotype,
  resetConfigCache,
  buildAgentsFromConfig,
  buildFallbackAdapter,
  buildMemoryProvider,
  buildContextProvider,
  DEFAULT_PARLIAMENT_DEFAULTS,
  DEFAULT_MEMORY_CONFIG,
  DEFAULT_CONTEXT_CONFIG,
} from './config.js';

export type {
  ContextProvider,
  ResolvedContext,
  ACRContextProviderConfig,
} from './context.js';
export {
  NoopContextProvider,
  ACRContextProvider,
  formatResolvedContext,
} from './context.js';

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

export type {
  Agent,
  AgentResult,
  AgentRuntimeOptions,
  ProviderFailoverInfo,
  SynthesizerResult,
  SentryResult,
} from './agents/index.js';
export { AgentBase } from './agents/index.js';
export {
  ProposerAgent,
  SkepticAgent,
  SynthesizerAgent,
  RedAgent,
  SentryAgent,
  StubNeurotypeAgent,
  CONTEXT_HEADING,
  SOURCES_HEADING,
  MEMORY_HEADING,
  ACR_CONTEXT_HEADING,
  CITATION_INSTRUCTION,
  DEFAULT_MAX_SOURCE_WORDS,
  buildPromptHeader,
  buildSourcesBlock,
  enforceWordCap,
  jaccardSimilarity,
  BUILTIN_AGENT_REGISTRY,
  BUILTIN_AGENT_IDS,
  isBuiltinNeurotype,
  createBuiltinAgent,
} from './agents/index.js';

export type {
  DeliberationConfig,
  TopologyDeliberationConfig,
  NeurotypeResolver,
  NeurotypeResolverContext,
  TopologyRuntimeLogger,
} from './engine.js';
export { DeliberationEngine } from './engine.js';

export type {
  TopologyConfig,
  TopologyPreset,
  TopologyStep,
  TopologyLogger,
  TopologyValidationCode,
  UserNeurotypeConfig,
} from './topology/index.js';
export {
  loadTopology,
  resolveActivePreset,
  BUILTIN_PRESETS,
  BUILTIN_PRESET_IDS,
  isBuiltinPreset,
  TopologyValidationError,
  DEFAULT_NEUROTYPE_TEMPERATURE,
  FALLBACK_PRESET_ID,
} from './topology/index.js';

export type { ScheduledTurn, BatchSchedule } from './scheduler/index.js';
export { buildBatchSchedule, countModelSwaps } from './scheduler/index.js';

export {
  computeOSI,
  detectEchoLoop,
  OSI_CONVERGENCE_THRESHOLD,
  MIN_TURNS_PER_ROLE_FOR_ECHO_CHECK,
} from './osi.js';

export type {
  MemoryLayer,
  MemoryFragment,
  MemoryOutcome,
  RecallOptions,
  RememberOptions,
  MemoryProvider,
  EngramMemoryProviderConfig,
} from './memory.js';
export {
  NoopMemoryProvider,
  EngramMemoryProvider,
  formatOutcomeForMemory,
  formatMemoryFragments,
} from './memory.js';

export type {
  IdeateMode,
  IdeateStyle,
  LineupRole,
  LineupAssignment,
  LineupTeam,
  ResolvedLineup,
  IdeatePhaseId,
  PhaseContribution,
  PhaseRecord,
  Problem,
  IdeationStatus,
  IdeationRecord,
  IdeateLineupOverrides,
  IdeateSynthOverrides,
  IdeateConfig,
} from './ideate/types.js';
export {
  CLOSED_MODELS,
  OPEN_MODELS,
  SYNTH_DEFAULTS,
  defaultLineup,
  resolveLineup,
} from './ideate/lineup.js';
export {
  ADVERSARIAL_SYSTEM_PROMPT,
  ADVERSARIAL_RETRY_INSTRUCTION,
  parseAdversarialOutput,
} from './ideate/adversarial.js';
export type { AdapterFactory, RunIdeationInput, RunIdeationResult } from './ideate/orchestrator.js';
export { runIdeation } from './ideate/orchestrator.js';
