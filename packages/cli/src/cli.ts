/**
 * cli.ts — Parliament CLI entry point.
 *
 * Exported as a named function so it can be imported and tested without
 * executing side-effects at import time.
 *
 * Commands:
 *   parliament deliberate "<topic>" [--model-proposer <id>] [--model-skeptic <id>]
 *                                   [--max-rounds <n>]
 *   parliament get <id>
 */

import { Command } from 'commander';
import {
  loadConfig,
  buildAgentsFromConfig,
  createAdapter,
  DeliberationEngine,
  ProposerAgent,
  SkepticAgent,
  SynthesizerAgent,
  RedAgent,
  SentryAgent,
  DEFAULT_PARLIAMENT_DEFAULTS,
} from '@parliament/core';
import type { DeliberationResult } from '@parliament/core';
import { printResult } from './display.js';

// ---------------------------------------------------------------------------
// Deliberate command
// ---------------------------------------------------------------------------

interface DeliberateOptions {
  modelProposer?: string;
  modelSkeptic?: string;
  maxRounds?: string;
  config?: string;
}

async function runDeliberate(topic: string, opts: DeliberateOptions): Promise<void> {
  const configPath = opts.config ?? process.env['PARLIAMENT_CONFIG'];
  const cfg = loadConfig(configPath);

  // Allow per-invocation model overrides for proposer and skeptic.
  const proposerModel = opts.modelProposer ?? cfg.neurotypes['proposer']?.model ?? 'llama3.2';
  const skepticModel = opts.modelSkeptic ?? cfg.neurotypes['skeptic']?.model ?? 'mistral';
  const synthModel = cfg.neurotypes['synthesizer']?.model ?? 'llama3.2';
  const redModel = cfg.neurotypes['redAgent']?.model ?? 'mistral';
  const sentryModel = cfg.neurotypes['sentry']?.model ?? 'llama3.2';

  const defaults = cfg.parliament ?? DEFAULT_PARLIAMENT_DEFAULTS;
  const maxRounds =
    opts.maxRounds !== undefined ? parseInt(opts.maxRounds, 10) : defaults.max_rounds;

  if (isNaN(maxRounds) || maxRounds < 1) {
    process.stderr.write('Parliament: --max-rounds must be a positive integer\n');
    process.exit(1);
  }

  const proposer = new ProposerAgent(createAdapter(proposerModel));
  const skeptic = new SkepticAgent(createAdapter(skepticModel));
  const synthesizer = new SynthesizerAgent(createAdapter(synthModel));
  const redAgent = new RedAgent(createAdapter(redModel));
  const sentry = new SentryAgent(createAdapter(sentryModel));

  const engine = new DeliberationEngine();

  const result = await engine.run(topic, {
    maxRounds,
    redAgentInterval: defaults.red_agent_interval,
    confidenceThreshold: defaults.confidence_threshold,
    agents: { proposer, skeptic, synthesizer, redAgent, sentry },
  });

  printResult(result);
}

// ---------------------------------------------------------------------------
// Get command
// ---------------------------------------------------------------------------

async function runGet(id: string): Promise<void> {
  const baseUrl =
    process.env['PARLIAMENT_SERVER_URL'] ?? 'http://localhost:3030';

  const url = `${baseUrl}/deliberate/${id}`;

  let resp: Response;
  try {
    resp = await fetch(url);
  } catch (err) {
    process.stderr.write(`Parliament: failed to reach server at ${url}: ${String(err)}\n`);
    process.exit(1);
  }

  if (!resp.ok) {
    process.stderr.write(
      `Parliament: server returned ${resp.status} for GET ${url}\n`,
    );
    process.exit(1);
  }

  let result: DeliberationResult;
  try {
    result = (await resp.json()) as DeliberationResult;
  } catch (err) {
    process.stderr.write(`Parliament: invalid JSON from server: ${String(err)}\n`);
    process.exit(1);
  }

  printResult(result);
}

// ---------------------------------------------------------------------------
// Program factory — exported for testing
// ---------------------------------------------------------------------------

/**
 * Builds and returns the Commander program without calling `.parse()`.
 * Tests can call `.parseAsync(['node', 'parliament', ...args])` on the returned
 * program to exercise commands without spawning a subprocess.
 */
export function createProgram(): Command {
  const program = new Command();

  program
    .name('parliament')
    .description('Multi-agent deliberation CLI')
    .version('0.0.1');

  program
    .command('deliberate <topic>')
    .description('Run a multi-agent deliberation on a topic')
    .option('--model-proposer <id>', 'Model ID override for the Proposer agent')
    .option('--model-skeptic <id>', 'Model ID override for the Skeptic agent')
    .option('--max-rounds <n>', 'Maximum number of deliberation rounds (default: 5)')
    .option('--config <path>', 'Path to parliament.toml config file')
    .action(async (topic: string, opts: DeliberateOptions) => {
      await runDeliberate(topic, opts);
    });

  program
    .command('get <id>')
    .description('Fetch and display a past deliberation by ID from the Parliament server')
    .action(async (id: string) => {
      await runGet(id);
    });

  return program;
}

// ---------------------------------------------------------------------------
// Main — only runs when executed directly (not imported by tests)
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  const program = createProgram();
  await program.parseAsync(process.argv);
}
