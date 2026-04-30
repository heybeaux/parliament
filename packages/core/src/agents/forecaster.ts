import type { ModelAdapter } from '../adapters/base.js';
import { StubNeurotypeAgent } from './stub-agent.js';

/**
 * Temporal posture: "Look forward." Reasons about second- and third-order
 * effects, how the proposed answer ages.
 *
 * STUB — implementation lands in the Forecaster per-agent task.
 */
export class ForecasterAgent extends StubNeurotypeAgent {
  constructor(adapter: ModelAdapter) {
    super('Forecaster', 'forecaster', adapter);
  }
}
