/**
 * ACR Capability Manifest Types
 * Vendored from heybeaux/acr @ 92daba5c36843c0e6703a98002e20ae01237e7ed
 * Source: packages/schema/src/types.ts
 *
 * Do not edit by hand. See integrations/acr/PIN.md for bump procedure.
 */

export type ResolutionLevel = 'index' | 'summary' | 'standard' | 'deep';
export type CapabilityType = 'capability' | 'capability-set';
export type TriggerType = 'pattern' | 'runtime_event' | 'semantic';
export type TriggerLogic = 'OR' | 'AND';
export type PermissionValue = 'allow' | 'deny';
export type DataPermission = 'read-only' | 'read-write' | 'never';
export type OverflowPolicy = 'demote_lowest_priority' | 'error' | 'request_human';
export type StateFieldType = 'string' | 'number' | 'boolean' | 'string[]' | 'object' | 'object[]';
export type PriorityLevel = 'critical' | 'high' | 'medium' | 'low';
export type ModelConstraint = 'requires-image-gen' | 'requires-vision' | 'requires-reasoning' | 'requires-code-exec' | 'requires-long-context';

export interface ModelPreference {
  preferred?: string;
  fallback?: string | null;
  constraint?: ModelConstraint;
}

export interface ToolRequirement {
  mcp: string;
  methods?: string[];
  optional?: boolean;
}

export interface CapabilityRequirement {
  name: string;
  resolution?: ResolutionLevel;
  optional?: boolean;
}

export interface ContextRequirement {
  ref: string;
  optional?: boolean;
}

export interface Trigger {
  type: TriggerType;
  match?: string;
  condition?: string;
  threshold?: number;
}

export interface Overlay {
  ref: string;
  optional?: boolean;
  priority?: number;
}

export interface StateField {
  name: string;
  type: StateFieldType;
}

export interface Budget {
  index: number;
  summary: number;
  standard: number;
  deep?: number;
  children_total?: number;
  overflow_policy?: OverflowPolicy;
}

export interface Activation {
  triggers?: Trigger[];
  trigger_logic?: TriggerLogic;
  co_activates?: string[];
  conflicts?: string[];
}

export interface Permissions {
  tools?: Record<string, Record<string, PermissionValue>>;
  data?: Record<string, DataPermission>;
}

export interface Behavioral {
  core: string;
  overlays?: Overlay[];
}

export interface StateSchema {
  version: number;
  max_size_tokens: number;
  fields: StateField[];
}

export interface Verification {
  checklist?: string[];
  completion_signal?: string;
}

export type CompensationModel = 'free' | 'per-use' | 'subscription' | 'donation' | 'token-gated';

export interface FundingConfig {
  model: CompensationModel;
  wallet?: string;
  token_id?: string;
  contract?: string;
  chain?: string;
}

export interface Publisher {
  author?: string;
  organization?: string;
  license?: string;
  repository?: string;
  content_hash?: string;
  signature?: string;
  registry_uri?: string;
  funding?: FundingConfig;
}

export interface CapabilityManifest {
  name: string;
  version: string;
  type: CapabilityType;
  description: string;
  provides: string[];
  requires?: {
    tools?: ToolRequirement[];
    capabilities?: CapabilityRequirement[];
    context?: ContextRequirement[];
  };
  budget: Budget;
  activation?: Activation;
  permissions?: Permissions;
  behavioral?: Behavioral;
  state_schema?: StateSchema;
  verification?: Verification;
  constraints?: string[];
  file_patterns?: string[];
  priority?: PriorityLevel;
  publisher?: Publisher;
  model?: ModelPreference;
}

export interface ResolvedCapability {
  manifest: CapabilityManifest;
  resolution: ResolutionLevel;
  loadOrder: number;
  transitiveDependencies: string[];
  budgetUsed: number;
}

export interface ResolutionPlan {
  capabilities: ResolvedCapability[];
  totalBudget: number;
  windowSize: number;
  utilization: number;
  conflicts: ConflictError[];
  warnings: string[];
}

export type ACRErrorCode =
  | 'DEPENDENCY_MISSING'
  | 'CONFLICT'
  | 'CIRCULAR_DEPENDENCY'
  | 'BUDGET_OVERFLOW'
  | 'TOOL_UNAVAILABLE'
  | 'MOUNT_FAILED'
  | 'PERMISSION_DENIED'
  | 'STATE_LOST'
  | 'TOOL_ERROR'
  | 'VERIFICATION_FAILED';

export interface ACRError {
  code: ACRErrorCode;
  message: string;
  capability?: string;
  details?: Record<string, unknown>;
}

export interface ConflictError {
  code: 'CONFLICT';
  capabilities: [string, string];
  sharedProvides: string[];
}
