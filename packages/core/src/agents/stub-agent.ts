import type { ModelAdapter } from '../adapters/base.js';
import type { Blackboard } from '../types.js';
import type { Agent, AgentResult } from './base.js';

/**
 * Placeholder implementation used by neurotype agents that are registered
 * but not yet implemented. Each Stage 1 per-agent task replaces its stub
 * file with the real implementation.
 *
 * The stub returns a marker string and never calls the model adapter,
 * so test fixtures can register a stubbed neurotype without needing a
 * mock backend.
 */
export class StubNeurotypeAgent implements Agent {
  readonly role: string;
  readonly neurotype: string;
  readonly modelName: string;

  constructor(
    role: string,
    neurotype: string,
    private readonly adapter: ModelAdapter,
  ) {
    this.role = role;
    this.neurotype = neurotype;
    this.modelName = adapter.modelName;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async generate(_blackboard: Blackboard): Promise<AgentResult> {
    return {
      content: `[${this.role} stub — implementation pending]`,
      truncated: false,
    };
  }
}
