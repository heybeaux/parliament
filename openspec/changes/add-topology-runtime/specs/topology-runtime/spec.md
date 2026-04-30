## ADDED Requirements

### Requirement: Engine MUST execute deliberations against a resolved topology

The deliberation engine MUST accept a resolved `Topology` object and execute its steps in declared order. It MUST NOT contain a hardcoded agent pipeline.

#### Scenario: Engine runs the Debate preset

- **WHEN** the engine is invoked with the Debate topology
- **THEN** it executes Proposer → Skeptic → Synthesizer → RedAgent in that order, per round, with the Sentry attached to the blackboard

#### Scenario: Engine runs a custom user-defined topology

- **WHEN** `parliament.toml` defines a preset `my-topology` with steps `[historian, proposer, empiricist, synthesizer]` and sets `active = "my-topology"`
- **THEN** the engine executes those four agents in order on every round

### Requirement: Six built-in presets MUST be registered with required metadata

`@parliament/core` MUST register six built-in presets: `debate`, `star-chamber`, `chain-of-verifiers`, `socratic`, `long-view`, `reframe`. Each MUST declare `name`, `description`, and `best_for`. Each MUST reference only registered neurotype IDs.

#### Scenario: Loading the registry exposes all six presets

- **WHEN** the runtime boots without a custom `parliament.toml`
- **THEN** the preset registry contains exactly the six built-in presets, each with non-empty metadata fields

#### Scenario: A preset references an unregistered neurotype

- **WHEN** a built-in preset references a neurotype ID that isn't in the registry
- **THEN** loading fails at startup with an error naming the offending preset and ID (this is a build-time guard, not a runtime error)

### Requirement: Absence of `[topology]` MUST fall back to Debate

When `parliament.toml` does not contain a `[topology]` section, the engine MUST select the `debate` preset and emit an info-level log entry recording the fallback.

#### Scenario: Config has no `[topology]` section

- **WHEN** `parliament.toml` lacks a `[topology]` section
- **THEN** the engine uses Debate and logs `topology.fallback preset=debate reason=absent`

#### Scenario: Config has `[topology]` but no `active` field

- **WHEN** `parliament.toml` has `[topology]` defined but does not set `active`
- **THEN** the engine uses Debate and logs `topology.fallback preset=debate reason=no-active`

### Requirement: Unknown active preset MUST be a hard error

When `[topology] active` references a name that doesn't exist in the registry, config loading MUST fail. The error message MUST list the available preset names.

#### Scenario: User sets `active` to an unknown name

- **WHEN** `parliament.toml` declares `[topology] active = "nonexistent"`
- **THEN** config loading fails with an error message including: the unknown name, and the full list of available preset names

### Requirement: Sentry MUST run as an out-of-band watcher across every preset

The Sentry MUST be attached to the blackboard and active for every deliberation regardless of which preset is selected. The Sentry MUST NOT appear in any preset's `steps` array.

#### Scenario: A non-default preset is active

- **WHEN** the engine runs the `socratic` preset
- **THEN** the Sentry is attached to the blackboard and observes turns, identical to its behavior under Debate

#### Scenario: A user-defined preset omits the Sentry from steps

- **WHEN** a user-defined preset defines `steps` without referencing `sentry`
- **THEN** the Sentry still runs as an out-of-band watcher (the user does not need to opt in)

### Requirement: Optional steps MUST be honored even without skip conditions

Steps marked `optional: true` MUST be wired through the executor with skip-condition evaluation. In this stage, no skip conditions are defined; the executor MUST run optional steps unless and until skip conditions are added in a later change.

#### Scenario: Step is marked optional with no skip condition

- **WHEN** a preset declares `{ id = "translate", neurotype = "translator", optional = true }`
- **THEN** the engine runs the step normally and records it in the transcript

### Requirement: Server MUST accept a per-deliberation preset override

The deliberation HTTP endpoint MUST accept an optional `preset` field in the request body. When present, the named preset MUST be used for that deliberation. When absent, the active preset from `parliament.toml` MUST be used.

#### Scenario: Request specifies a known preset

- **WHEN** a deliberation request body contains `{ "preset": "long-view", "topic": "..." }`
- **THEN** the server runs the deliberation using the Long-View preset

#### Scenario: Request specifies an unknown preset

- **WHEN** a deliberation request body contains `{ "preset": "nonexistent", "topic": "..." }`
- **THEN** the server returns HTTP 400 with a body listing the available preset names

### Requirement: CLI MUST accept a `--preset` flag

`@parliament/cli` MUST accept `--preset <name>` to select a preset for a single CLI invocation.

#### Scenario: CLI invocation with `--preset`

- **WHEN** the user runs `parliament deliberate --preset socratic --topic "..."`
- **THEN** the CLI sends a deliberation request with `preset = "socratic"`
