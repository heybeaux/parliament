import { describe, it, expect, vi } from 'vitest';
import { parse } from 'smol-toml';
import {
  loadTopology,
  BUILTIN_PRESETS,
  DEFAULT_NEUROTYPE_TEMPERATURE,
  FALLBACK_PRESET_ID,
  TopologyValidationError,
  type TopologyLogger,
} from '../index.js';

/**
 * Helper: parse TOML the same way `config.ts` does, then run it through the
 * topology loader. Shrinks per-test boilerplate.
 */
function load(toml: string, logger?: TopologyLogger) {
  const parsed = parse(toml);
  return loadTopology(parsed, logger ? { logger } : {});
}

function expectThrowsWithCode(
  fn: () => unknown,
  code: import('../types.js').TopologyValidationCode,
  messageMatch?: RegExp,
): TopologyValidationError {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(TopologyValidationError);
  const err = caught as TopologyValidationError;
  expect(err.code).toBe(code);
  if (messageMatch) expect(err.message).toMatch(messageMatch);
  return err;
}

describe('loadTopology — happy path (AC1)', () => {
  it('returns a TopologyConfig with the resolved active preset', () => {
    const config = load(`
[topology]
active = "debate"
`);
    expect(config.activePreset.id).toBe('debate');
    expect(config.activePreset.isBuiltin).toBe(true);
    expect(config.activePreset.steps.length).toBeGreaterThan(0);
    // Built-in presets are always present.
    expect(config.presets['debate']).toBeDefined();
  });

  it('round-trips the built-in debate preset metadata', () => {
    const config = load(`
[topology]
active = "debate"
`);
    expect(config.activePreset.name).toBe(BUILTIN_PRESETS['debate']!.name);
    expect(config.activePreset.description).toBe(BUILTIN_PRESETS['debate']!.description);
    expect(config.activePreset.best_for).toBe(BUILTIN_PRESETS['debate']!.best_for);
  });

  it('accepts a user-defined preset alongside built-ins', () => {
    const config = load(`
[topology]
active = "my-flow"

[topology.presets.my-flow]
name = "My Flow"
description = "A custom three-voice flow."
best_for = "Spec-driven testing of the loader."
steps = [
  { id = "proposer", neurotype = "proposer" },
  { id = "skeptic", neurotype = "skeptic" },
  { id = "translator", neurotype = "translator" },
]
`);
    expect(config.activePreset.id).toBe('my-flow');
    expect(config.activePreset.isBuiltin).toBe(false);
    expect(config.activePreset.steps).toHaveLength(3);
    expect(config.activePreset.steps[2]!.neurotype).toBe('translator');
    expect(config.activePreset.steps[2]!.optional).toBe(false);
    expect(config.presets['debate']).toBeDefined();
    expect(config.presets['my-flow']).toBeDefined();
  });

  it('preserves explicit optional=true on a step', () => {
    const config = load(`
[topology]
active = "with-optional"

[topology.presets.with-optional]
name = "With Optional"
description = "Preset with an opt-in skippable step."
best_for = "Testing strict-by-default semantics."
steps = [
  { id = "proposer", neurotype = "proposer" },
  { id = "skeptic", neurotype = "skeptic", optional = true },
]
`);
    expect(config.activePreset.steps[0]!.optional).toBe(false);
    expect(config.activePreset.steps[1]!.optional).toBe(true);
  });
});

describe('loadTopology — neurotype handling', () => {
  it('parses user-defined neurotypes with all fields populated', () => {
    const config = load(`
[topology]
active = "debate"

[neurotypes.regulator]
model = "qwen3:8b"
system_prompt = "You are a regulator."
description = "Compliance-first posture."
temperature = 0.3
provider = "ollama"
`);
    expect(config.userNeurotypes['regulator']).toEqual({
      model: 'qwen3:8b',
      system_prompt: 'You are a regulator.',
      description: 'Compliance-first posture.',
      temperature: 0.3,
      provider: 'ollama',
    });
  });

  it('applies the 0.7 temperature default when omitted', () => {
    const config = load(`
[topology]
active = "debate"

[neurotypes.regulator]
model = "qwen3:8b"
system_prompt = "You are a regulator."
`);
    expect(config.userNeurotypes['regulator']!.temperature).toBe(DEFAULT_NEUROTYPE_TEMPERATURE);
    expect(config.userNeurotypes['regulator']!.temperature).toBe(0.7);
  });

  it('resolves a step neurotype against a user-defined entry', () => {
    const config = load(`
[topology]
active = "with-regulator"

[topology.presets.with-regulator]
name = "With Regulator"
description = "User-defined neurotype as a step."
best_for = "Testing user-defined neurotype resolution."
steps = [
  { id = "proposer", neurotype = "proposer" },
  { id = "regulator", neurotype = "regulator" },
]

[neurotypes.regulator]
model = "qwen3:8b"
system_prompt = "You are a regulator."
`);
    expect(config.activePreset.steps[1]!.neurotype).toBe('regulator');
    expect(config.userNeurotypes['regulator']).toBeDefined();
  });
});

describe('loadTopology — validation errors (AC2)', () => {
  it('rejects an unknown neurotype reference with a descriptive error', () => {
    const err = expectThrowsWithCode(
      () =>
        load(`
[topology]
active = "broken"

[topology.presets.broken]
name = "Broken"
description = "Has a typo'd neurotype reference."
best_for = "Negative test."
steps = [{ id = "proposer", neurotype = "histroian" }]
`),
      'unknown_neurotype',
      /unknown neurotype "histroian"/,
    );
    // Error message lists known built-in IDs so the user knows what's available.
    expect(err.message).toMatch(/historian/);
  });

  it('rejects duplicate step IDs within a preset', () => {
    expectThrowsWithCode(
      () =>
        load(`
[topology]
active = "duped"

[topology.presets.duped]
name = "Duped"
description = "Two steps share an ID."
best_for = "Negative test."
steps = [
  { id = "critique", neurotype = "skeptic" },
  { id = "critique", neurotype = "devils-advocate" },
]
`),
      'duplicate_step_id',
      /duplicate step id "critique"/,
    );
  });

  it('rejects snake_case step IDs', () => {
    expectThrowsWithCode(
      () =>
        load(`
[topology]
active = "snaked"

[topology.presets.snaked]
name = "Snaked"
description = "Step ID uses snake_case."
best_for = "Negative test."
steps = [{ id = "devils_advocate", neurotype = "devils-advocate" }]
`),
      'invalid_step_id_format',
      /kebab-case/,
    );
  });

  it('rejects PascalCase step IDs', () => {
    expectThrowsWithCode(
      () =>
        load(`
[topology]
active = "pascaled"

[topology.presets.pascaled]
name = "Pascaled"
description = "Step ID uses PascalCase."
best_for = "Negative test."
steps = [{ id = "DevilsAdvocate", neurotype = "devils-advocate" }]
`),
      'invalid_step_id_format',
      /kebab-case/,
    );
  });

  it('rejects step IDs that begin with a digit', () => {
    expectThrowsWithCode(
      () =>
        load(`
[topology]
active = "digited"

[topology.presets.digited]
name = "Digited"
description = "Step ID begins with a digit."
best_for = "Negative test."
steps = [{ id = "1critique", neurotype = "skeptic" }]
`),
      'invalid_step_id_format',
      /kebab-case/,
    );
  });

  it('rejects user-defined presets missing required metadata (best_for)', () => {
    const err = expectThrowsWithCode(
      () =>
        load(`
[topology]
active = "incomplete"

[topology.presets.incomplete]
name = "Incomplete"
description = "Missing best_for."
steps = [{ id = "proposer", neurotype = "proposer" }]
`),
      'missing_metadata',
      /best_for/,
    );
    expect(err.message).toMatch(/incomplete/);
  });

  it('rejects user-defined neurotypes missing a system_prompt', () => {
    expectThrowsWithCode(
      () =>
        load(`
[topology]
active = "debate"

[neurotypes.regulator]
model = "qwen3:8b"
`),
      'invalid_neurotype_shape',
      /system_prompt/,
    );
  });
});

describe('loadTopology — Sentry-in-steps (AC3)', () => {
  it('rejects Sentry referenced as a preset step', () => {
    const err = expectThrowsWithCode(
      () =>
        load(`
[topology]
active = "sentried"

[topology.presets.sentried]
name = "Sentried"
description = "Tries to put Sentry in steps."
best_for = "Negative test for structural-infrastructure rule."
steps = [
  { id = "proposer", neurotype = "proposer" },
  { id = "watch", neurotype = "sentry" },
]
`),
      'sentry_in_steps',
      /sentry/,
    );
    // Message must call out that Sentry is structural infrastructure.
    expect(err.message).toMatch(/structural infrastructure/);
  });
});

describe('loadTopology — unknown active preset (AC4)', () => {
  it('emits a "did you mean" suggestion when a built-in is within edit distance 2', () => {
    expectThrowsWithCode(
      () =>
        load(`
[topology]
active = "debat"
`),
      'unknown_active_preset',
      /did you mean "debate"/,
    );
  });

  it('omits the suggestion when no preset is within edit distance 2', () => {
    const err = expectThrowsWithCode(
      () =>
        load(`
[topology]
active = "xyzzy"
`),
      'unknown_active_preset',
    );
    expect(err.message).not.toMatch(/did you mean/);
    // Available presets list MUST appear regardless. With multiple built-ins,
    // the loader emits them sorted alphabetically.
    expect(err.message).toMatch(/Available presets: \[/);
    expect(err.message).toMatch(/debate/);
  });

  it('lists user-defined presets in the available list', () => {
    const err = expectThrowsWithCode(
      () =>
        load(`
[topology]
active = "wrong"

[topology.presets.my-flow]
name = "My Flow"
description = "Custom flow."
best_for = "Listing test."
steps = [{ id = "proposer", neurotype = "proposer" }]
`),
      'unknown_active_preset',
    );
    expect(err.message).toMatch(/my-flow/);
    expect(err.message).toMatch(/debate/);
  });
});

describe('loadTopology — fallback to debate (AC5)', () => {
  it('falls back to "debate" with an info-level log when [topology] is absent', () => {
    const logger: TopologyLogger = { info: vi.fn() };
    const config = load(``, logger);
    expect(config.activePreset.id).toBe(FALLBACK_PRESET_ID);
    expect(logger.info).toHaveBeenCalledTimes(1);
    const message = (logger.info as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(message).toMatch(/no \[topology\] block/);
    expect(message).toMatch(/falling back to "debate"/);
  });

  it('falls back to "debate" when [topology] is present but active is unset', () => {
    const logger: TopologyLogger = { info: vi.fn() };
    const config = load(`[topology]
`, logger);
    expect(config.activePreset.id).toBe(FALLBACK_PRESET_ID);
    expect(logger.info).toHaveBeenCalledTimes(1);
  });

  it('does not log when [topology].active is explicitly set', () => {
    const logger: TopologyLogger = { info: vi.fn() };
    load(`
[topology]
active = "debate"
`, logger);
    expect(logger.info).not.toHaveBeenCalled();
  });
});

describe('loadTopology — preset ID collisions', () => {
  it('rejects a user-defined preset that collides with a built-in', () => {
    expectThrowsWithCode(
      () =>
        load(`
[topology]
active = "debate"

[topology.presets.debate]
name = "Debate Override"
description = "Tries to shadow the built-in."
best_for = "Negative test."
steps = [{ id = "proposer", neurotype = "proposer" }]
`),
      'preset_id_collision',
      /collides with a built-in/,
    );
  });
});

describe('loadTopology — top-level shape errors', () => {
  it('rejects an array at the top level', () => {
    expectThrowsWithCode(
      () => loadTopology([]),
      'invalid_topology_shape',
      /top-level/,
    );
  });

  it('rejects a non-string [topology].active', () => {
    expectThrowsWithCode(
      () =>
        load(`
[topology]
active = 42
`),
      'invalid_topology_shape',
      /must be a string/,
    );
  });
});

describe('loadTopology — parallel_steps schema (Stage 4)', () => {
  it('accepts a preset with both steps and parallel_steps', () => {
    const config = load(`
[topology]
active = "jury-like"

[topology.presets.jury-like]
name = "Jury-like"
description = "User-defined preset that mirrors Jury's shape."
best_for = "parallel critic deliberation"
steps = [
  { id = "proposer", neurotype = "proposer" },
]
parallel_steps = [
  { id = "skeptic", neurotype = "skeptic" },
  { id = "empiricist", neurotype = "empiricist" },
  { id = "steelmanner", neurotype = "steelmanner" },
  { id = "devils-advocate", neurotype = "devils-advocate" },
]
`);
    const preset = config.presets['jury-like'];
    expect(preset).toBeDefined();
    expect(preset!.steps.map((s) => s.id)).toEqual(['proposer']);
    expect(preset!.parallel_steps).toBeDefined();
    expect(preset!.parallel_steps!.map((s) => s.id)).toEqual([
      'skeptic',
      'empiricist',
      'steelmanner',
      'devils-advocate',
    ]);
  });

  it('treats absent parallel_steps as a no-op (sequential-only preset still validates)', () => {
    const config = load(`
[topology]
active = "seq-only"

[topology.presets.seq-only]
name = "Sequential Only"
description = "No parallel block."
best_for = "regression test for additive parallel_steps."
steps = [
  { id = "proposer", neurotype = "proposer" },
  { id = "skeptic", neurotype = "skeptic" },
]
`);
    const preset = config.presets['seq-only'];
    expect(preset).toBeDefined();
    expect(preset!.parallel_steps).toBeUndefined();
  });

  it('built-in sequential-only presets continue to validate without parallel_steps', () => {
    const config = load(`
[topology]
active = "debate"
`);
    expect(config.activePreset.parallel_steps).toBeUndefined();
    // Verify every built-in preset is loadable with no errors.
    for (const id of Object.keys(BUILTIN_PRESETS)) {
      const c = load(`
[topology]
active = "${id}"
`);
      expect(c.activePreset.id).toBe(id);
    }
  });

  it('rejects a step ID that appears in both steps and parallel_steps', () => {
    expectThrowsWithCode(
      () =>
        load(`
[topology]
active = "dup-cross"

[topology.presets.dup-cross]
name = "Duplicate Across Blocks"
description = "Same id in steps and parallel_steps."
best_for = "Negative test."
steps = [{ id = "critique", neurotype = "skeptic" }]
parallel_steps = [{ id = "critique", neurotype = "empiricist" }]
`),
      'duplicate_step_id',
      /both steps and parallel_steps/,
    );
  });

  it('rejects duplicate IDs within parallel_steps itself', () => {
    expectThrowsWithCode(
      () =>
        load(`
[topology]
active = "dup-par"

[topology.presets.dup-par]
name = "Dup Parallel"
description = "Two parallel siblings share an ID."
best_for = "Negative test."
steps = [{ id = "proposer", neurotype = "proposer" }]
parallel_steps = [
  { id = "voice", neurotype = "skeptic" },
  { id = "voice", neurotype = "empiricist" },
]
`),
      'duplicate_step_id',
      /appears twice in parallel_steps/,
    );
  });

  it('rejects parallel_steps that is not an array', () => {
    expectThrowsWithCode(
      () =>
        load(`
[topology]
active = "bad-par"

[topology.presets.bad-par]
name = "Bad Parallel"
description = "parallel_steps is a table, not an array."
best_for = "Negative test."
steps = [{ id = "proposer", neurotype = "proposer" }]
parallel_steps = { id = "skeptic", neurotype = "skeptic" }
`),
      'invalid_preset_shape',
      /parallel_steps must be an array/,
    );
  });

  it('rejects sentry/synthesizer/redAgent inside parallel_steps', () => {
    expectThrowsWithCode(
      () =>
        load(`
[topology]
active = "sentry-par"

[topology.presets.sentry-par]
name = "Sentry In Parallel"
description = "Sentry must not appear as a step in any block."
best_for = "Negative test."
steps = [{ id = "proposer", neurotype = "proposer" }]
parallel_steps = [{ id = "watch", neurotype = "sentry" }]
`),
      'sentry_in_steps',
      /structural infrastructure/,
    );
  });

  it('rejects unknown neurotypes inside parallel_steps with the same error class', () => {
    expectThrowsWithCode(
      () =>
        load(`
[topology]
active = "ghost-par"

[topology.presets.ghost-par]
name = "Ghost Parallel"
description = "References a neurotype that does not exist."
best_for = "Negative test."
steps = [{ id = "proposer", neurotype = "proposer" }]
parallel_steps = [{ id = "ghost", neurotype = "doesnotexist" }]
`),
      'unknown_neurotype',
      /unknown neurotype "doesnotexist"/,
    );
  });
});
