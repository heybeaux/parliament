import type { ModelAdapter } from '../adapters/base.js';
import type { Blackboard } from '../types.js';
import { AgentBase, type AgentResult, type AgentRuntimeOptions } from './base.js';

/**
 * Placeholder implementation used by neurotype agents that are registered
 * but not yet implemented. Each Stage 1 per-agent task replaces its stub
 * file with the real implementation.
 *
 * The stub returns a marker string and never calls the model adapter,
 * so test fixtures can register a stubbed neurotype without needing a
 * mock backend.
 *
 * PAR-25: extends AgentBase for the failover wiring even though
 * `generate()` here never reaches the adapter — the engine constructs
 * stubs uniformly via `BUILTIN_AGENT_REGISTRY` / the user-defined
 * resolver, so accepting `AgentRuntimeOptions` lets the same wiring path
 * apply to every agent class.
 */
export class StubNeurotypeAgent extends AgentBase {
  readonly role: string;
  readonly neurotype: string;

  constructor(
    role: string,
    neurotype: string,
    adapter: ModelAdapter,
    options: AgentRuntimeOptions = {},
  ) {
    super(adapter, options);
    this.role = role;
    this.neurotype = neurotype;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async generate(_blackboard: Blackboard): Promise<AgentResult> {
    return {
      content: `[${this.role} stub — implementation pending]`,
      truncated: false,
    };
  }
}
