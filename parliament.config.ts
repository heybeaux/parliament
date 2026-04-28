/**
 * Parliament configuration — typed defaults that mirror parliament.toml.
 *
 * The runtime loader (@parliament/core's loadConfig) reads parliament.toml.
 * This file documents the defaults in TypeScript and re-exports the canonical
 * type so consumers can statically reference the shape.
 */

import type { ParliamentTomlConfig } from '@parliament/core';
import { DEFAULT_PARLIAMENT_DEFAULTS } from '@parliament/core';

export type { ParliamentTomlConfig, ParliamentDefaults, NeurotypeConfig } from '@parliament/core';
export { DEFAULT_PARLIAMENT_DEFAULTS };

export const defaultConfig: ParliamentTomlConfig = {
  parliament: DEFAULT_PARLIAMENT_DEFAULTS,
  neurotypes: {
    proposer: {
      model: 'llama3.2',
      system_prompt:
        'You are a structured reasoner. Propose a clear, well-reasoned initial response to the topic. Stay within 100 words.',
    },
    skeptic: {
      model: 'mistral',
      system_prompt:
        'You are a rigorous critic. Identify logical leaps, unsupported assumptions, and potential errors in the previous response. Stay within 100 words.',
    },
    synthesizer: {
      model: 'llama3.2',
      system_prompt:
        'You are a synthesizer. Attempt to reconcile conflicting positions into a more robust unified view. Acknowledge what remains unresolved. Stay within 100 words.',
    },
    redAgent: {
      model: 'mistral',
      system_prompt:
        'You are a disruptor. Inject a challenging perspective that prevents premature consensus. Target the weakest assumption in the current debate. Stay within 100 words.',
    },
    sentry: {
      model: 'llama3.2',
      system_prompt:
        'You are a monitor. Identify if the current debate shows signs of echo (agents agreeing without genuine synthesis) or uncertainty collapse. Return only: OK, SPECIALIST_NEEDED, or COLLAPSE_DETECTED.',
    },
  },
};
