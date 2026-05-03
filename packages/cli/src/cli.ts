/**
 * cli.ts — Parliament CLI entry point.
 *
 * Exported as a named function so it can be imported and tested without
 * executing side-effects at import time.
 *
 * Commands:
 *   parliament deliberate "<topic>" [--preset <name>]
 *                                   [--model-proposer <id>] [--model-skeptic <id>]
 *                                   [--max-rounds <n>] [--config <path>]
 *   parliament get <id>
 */

import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import {
  loadConfig,
  loadTopologyConfig,
  resolveActivePreset,
  createAdapter,
  DeliberationEngine,
  ProposerAgent,
  SkepticAgent,
  SynthesizerAgent,
  RedAgent,
  SentryAgent,
  StubNeurotypeAgent,
  TopologyValidationError,
  isBuiltinNeurotype,
  createBuiltinAgent,
  DEFAULT_PARLIAMENT_DEFAULTS,
} from '@parliament/core';
import type {
  Agent,
  DeliberationResult,
  DeliberationSource,
  TopologyStep,
} from '@parliament/core';
import { printResult } from './display.js';

// ---------------------------------------------------------------------------
// Deliberate command
// ---------------------------------------------------------------------------

interface DeliberateOptions {
  preset?: string;
  modelProposer?: string;
  modelSkeptic?: string;
  maxRounds?: string;
  config?: string;
  /**
   * Path to a UTF-8 file whose contents will be sent as the deliberation's
   * `context` field (PAR-16). The engine prepends the file's contents to
   * every non-Sentry agent's user prompt under a stable `## Background`
   * heading. Prefer this over the deprecated inline `CONTEXT:` marker
   * approach in the topic string — that workaround still parses for
   * back-compat but pollutes the topic display.
   */
  contextFile?: string;
  /**
   * One or more file paths to attach as structured `sources[]` (PAR-17).
   * Repeatable: `--source ./a.md --source ./b.txt` produces a 2-source
   * deliberation. The engine renders them under a `## Sources` block on
   * every non-Sentry agent's user prompt and the Empiricist activates
   * evidence-backed claim mode. Per-source word cap is set via
   * `--max-source-words` (default 500) and applied at prompt construction
   * time.
   */
  source?: string[];
  /**
   * Per-source word cap forwarded to the engine's `maxSourceWords` config
   * (PAR-17). Optional. Must parse to a positive integer.
   */
  maxSourceWords?: string;
}

/**
 * Map a file extension to a `DeliberationSource.kind`. The taxonomy is the
 * fixed enum the engine accepts; everything else maps to `other` so a user
 * can drop in any UTF-8 file without the CLI rejecting it. The engine
 * itself never enforces kind correctness — it only uses the value as a
 * presentation chip in the prompt header.
 */
function deriveKindFromExt(ext: string): DeliberationSource['kind'] {
  const e = ext.toLowerCase().replace(/^\./, '');
  if (e === 'md' || e === 'pdf' || e === 'tex') return 'paper';
  if (e === 'memo' || e === 'doc' || e === 'docx' || e === 'rtf') return 'memo';
  if (
    e === 'ts' ||
    e === 'tsx' ||
    e === 'js' ||
    e === 'jsx' ||
    e === 'py' ||
    e === 'rs' ||
    e === 'go' ||
    e === 'java' ||
    e === 'rb' ||
    e === 'sh' ||
    e === 'cpp' ||
    e === 'c' ||
    e === 'h'
  ) {
    return 'code';
  }
  if (e === 'srt' || e === 'vtt' || e === 'transcript') return 'transcript';
  return 'other';
}

/**
 * Read the user-supplied source files from disk and turn each into a
 * structured `DeliberationSource`. Returns `undefined` when no
 * `--source` flag was passed.
 *
 *   - `id` derived from the file basename (sans extension) so citations
 *     stay stable even if the same file is re-used across runs.
 *   - `title` defaults to the bare filename so users see something they
 *     recognise in the UI Sources panel.
 *   - `kind` derived from the file extension via {@link deriveKindFromExt}.
 *   - `content` is the file's UTF-8 prose; the engine truncates to the
 *     `maxSourceWords` cap at prompt-construction time.
 *
 * Fails fast with a clear CLI-level error if any file cannot be read so
 * the user finds out before the model spin-up.
 *
 * Exported for direct unit-testing of the argv → request body shape.
 */
export function readSourcesFromArgs(
  paths: string[] | undefined,
): DeliberationSource[] | undefined {
  if (paths === undefined || paths.length === 0) return undefined;
  const sources: DeliberationSource[] = [];
  for (const p of paths) {
    let content: string;
    try {
      content = fs.readFileSync(p, 'utf8');
    } catch (err) {
      process.stderr.write(
        `Parliament: failed to read --source "${p}": ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
      process.exit(1);
    }
    const base = path.basename(p);
    const ext = path.extname(base);
    const id = ext.length > 0 ? base.slice(0, -ext.length) : base;
    const kind = deriveKindFromExt(ext);
    const source: DeliberationSource = {
      id,
      title: base,
      content,
    };
    if (kind !== undefined) source.kind = kind;
    sources.push(source);
  }
  return sources;
}

/**
 * Reads the user-supplied context file from disk. Returns `undefined` when
 * the option is not set; throws a clear CLI-level error and exits when the
 * file is unreadable so callers can't silently send an empty context.
 */
function readContextFile(p: string | undefined): string | undefined {
  if (p === undefined) return undefined;
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (err) {
    process.stderr.write(
      `Parliament: failed to read --context-file "${p}": ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
    process.exit(1);
  }
}

async function runDeliberate(topic: string, opts: DeliberateOptions): Promise<void> {
  const configPath = opts.config ?? process.env['PARLIAMENT_CONFIG'];
  const cfg = loadConfig(configPath);
  // PAR-16: optional --context-file. We resolve once up-front so a missing
  // file fails fast (before models are loaded) rather than mid-run.
  const context = readContextFile(opts.contextFile);

  // PAR-17: optional --source flags. Read each file once up-front (same
  // fail-fast rationale as --context-file) and derive id/kind/title.
  const sources = readSourcesFromArgs(opts.source);

  let maxSourceWords: number | undefined;
  if (opts.maxSourceWords !== undefined) {
    maxSourceWords = parseInt(opts.maxSourceWords, 10);
    if (isNaN(maxSourceWords) || maxSourceWords < 1) {
      process.stderr.write(
        'Parliament: --max-source-words must be a positive integer\n',
      );
      process.exit(1);
    }
  }

  const defaults = cfg.parliament ?? DEFAULT_PARLIAMENT_DEFAULTS;
  const maxRounds =
    opts.maxRounds !== undefined ? parseInt(opts.maxRounds, 10) : defaults.max_rounds;

  if (isNaN(maxRounds) || maxRounds < 1) {
    process.stderr.write('Parliament: --max-rounds must be a positive integer\n');
    process.exit(1);
  }

  // Structural-infrastructure agents (synthesizer, redAgent, sentry) are
  // always wired. They are NOT steppable in topology presets but the engine
  // requires them on both code paths.
  const synthModel = cfg.neurotypes['synthesizer']?.model ?? 'llama3.2';
  const redModel = cfg.neurotypes['redAgent']?.model ?? 'mistral';
  const sentryModel = cfg.neurotypes['sentry']?.model ?? 'llama3.2';

  const synthesizer = new SynthesizerAgent(
    createAdapter(synthModel, cfg.neurotypes['synthesizer']?.provider),
  );
  const redAgent = new RedAgent(
    createAdapter(redModel, cfg.neurotypes['redAgent']?.provider),
  );
  const sentry = new SentryAgent(
    createAdapter(sentryModel, cfg.neurotypes['sentry']?.provider),
    {
      osiEnabled: defaults.osi_enabled,
      osiSimilarityThreshold: defaults.osi_threshold,
    },
  );

  const engine = new DeliberationEngine();

  // Load the topology config once; we need it both to know the active preset
  // (so we can stay on the legacy path when it's "debate" and no override was
  // supplied) and to feed `runTopology` when we route through topology mode.
  const baseTopology = (() => {
    try {
      return loadTopologyConfig({ explicitPath: configPath });
    } catch (err) {
      if (err instanceof TopologyValidationError) {
        process.stderr.write(`Parliament: ${err.message}\n`);
        process.exit(1);
      }
      throw err;
    }
  })();

  const useTopologyPath =
    opts.preset !== undefined || baseTopology.activePreset.id !== 'debate';

  let result: DeliberationResult;

  if (useTopologyPath) {
    let topology;
    try {
      topology = resolveActivePreset(
        baseTopology,
        opts.preset ?? baseTopology.activePreset.id,
      );
    } catch (err) {
      if (err instanceof TopologyValidationError) {
        process.stderr.write(`Parliament: ${err.message}\n`);
        process.exit(1);
      }
      throw err;
    }

    const resolveNeurotype = (step: TopologyStep): Agent => {
      const neurotype = cfg.neurotypes[step.neurotype];
      if (!neurotype) {
        throw new Error(
          `Parliament: step "${step.id}" references neurotype "${step.neurotype}" but no [neurotypes.${step.neurotype}] entry exists in parliament.toml`,
        );
      }
      const adapter = createAdapter(neurotype.model, neurotype.provider);
      if (isBuiltinNeurotype(step.neurotype)) {
        return createBuiltinAgent(step.neurotype, adapter);
      }
      return new StubNeurotypeAgent(step.id, step.neurotype, adapter);
    };

    result = await engine.runTopology(topic, {
      maxRounds,
      redAgentInterval: defaults.red_agent_interval,
      confidenceThreshold: defaults.confidence_threshold,
      topology,
      resolveNeurotype,
      synthesizer,
      redAgent,
      sentry,
      ...(context !== undefined ? { context } : {}),
      ...(sources !== undefined ? { sources } : {}),
      ...(maxSourceWords !== undefined ? { maxSourceWords } : {}),
    });
  } else {
    // Legacy 5-agent path — preserved byte-identically for the default Debate
    // preset to honor task d520d96a's regression contract.
    const proposerModel = opts.modelProposer ?? cfg.neurotypes['proposer']?.model ?? 'llama3.2';
    const skepticModel = opts.modelSkeptic ?? cfg.neurotypes['skeptic']?.model ?? 'mistral';

    const proposer = new ProposerAgent(
      createAdapter(proposerModel, cfg.neurotypes['proposer']?.provider),
    );
    const skeptic = new SkepticAgent(
      createAdapter(skepticModel, cfg.neurotypes['skeptic']?.provider),
    );

    result = await engine.run(topic, {
      maxRounds,
      redAgentInterval: defaults.red_agent_interval,
      confidenceThreshold: defaults.confidence_threshold,
      agents: { proposer, skeptic, synthesizer, redAgent, sentry },
      ...(context !== undefined ? { context } : {}),
      ...(sources !== undefined ? { sources } : {}),
      ...(maxSourceWords !== undefined ? { maxSourceWords } : {}),
    });
  }

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
    .option('--preset <name>', 'Override [topology].active for this run')
    .option('--model-proposer <id>', 'Model ID override for the Proposer agent')
    .option('--model-skeptic <id>', 'Model ID override for the Skeptic agent')
    .option('--max-rounds <n>', 'Maximum number of deliberation rounds (default: 5)')
    .option('--config <path>', 'Path to parliament.toml config file')
    .option(
      '--context-file <path>',
      // PAR-16: prefer this over the deprecated inline `CONTEXT:` marker
      // approach. Each agent sees the file contents under a stable
      // `## Background` heading at the top of its user prompt.
      'Path to a UTF-8 file whose contents are sent as the deliberation context (prepended to every agent prompt). The legacy inline `CONTEXT:` marker in <topic> is deprecated.',
    )
    .option(
      '--source <path>',
      // PAR-17: repeatable. Commander's variadic-collector pattern is used —
      // pass a custom accumulator so `--source a --source b` produces
      // `["a", "b"]` rather than just the last value.
      'Path to a UTF-8 file to attach as a structured source (PAR-17). Repeatable: pass `--source <path>` multiple times to attach several sources. The id is derived from the file basename (e.g. `foo-2024.md` -> `foo-2024`); the kind is derived from the extension; the content is the file body, truncated to `--max-source-words` (default 500) at prompt time.',
      (value: string, prev: string[] = []) => prev.concat([value]),
      [] as string[],
    )
    .option(
      '--max-source-words <n>',
      'Per-source word cap applied at prompt-construction time (PAR-17). Default: 500.',
    )
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
