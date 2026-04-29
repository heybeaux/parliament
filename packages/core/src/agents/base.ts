import type { Blackboard } from '../types.js';

export interface AgentResult {
  content: string;
  truncated: boolean;
}

export interface Agent {
  role: string;
  neurotype: string;
  readonly modelName: string;
  generate(blackboard: Blackboard): Promise<AgentResult>;
}
