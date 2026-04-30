## ADDED Requirements

### Requirement: Topology presets MUST be configurable in `parliament.toml`

`parliament.toml` MUST support a `[topology]` section that lets the user pick an active preset by name and define one or more presets inline. When `[topology]` is absent, the engine MUST fall back to a built-in default preset.

#### Scenario: User selects a built-in preset

- **WHEN** `parliament.toml` contains `[topology] active = "debate"` and no preset definitions
- **THEN** the engine resolves "debate" against the built-in preset registry and uses that topology for every deliberation

#### Scenario: `[topology]` section is absent

- **WHEN** `parliament.toml` does not contain a `[topology]` section
- **THEN** the engine uses the built-in `debate` preset and emits an info-level log indicating the fallback

### Requirement: Every preset MUST declare required metadata

Each preset definition MUST include `name`, `description`, and `best_for` fields. All three are required string fields. Loading MUST fail with a validation error if any preset omits any of these fields.

#### Scenario: Preset declares all required metadata

- **WHEN** a preset declares `name = "Debate"`, `description = "..."`, `best_for = "..."` plus a `steps` array
- **THEN** the preset is accepted as valid

#### Scenario: Preset omits `best_for`

- **WHEN** a preset defines `name` and `description` but not `best_for`
- **THEN** config loading fails with a validation error naming the offending preset and the missing field

### Requirement: Topology steps MUST execute strictly by default

Every step in a preset's `steps` array MUST execute on every deliberation pass, unless the step explicitly declares `optional = true`. The engine MUST NOT skip a step that is not marked optional, regardless of runtime heuristics.

#### Scenario: Step is not marked optional

- **WHEN** a step declares only `id` and `neurotype` (no `optional` field)
- **THEN** the engine treats the step as required and executes it on every pass

#### Scenario: Step is explicitly optional

- **WHEN** a step declares `optional = true` along with skip conditions
- **THEN** the engine MAY skip the step when its skip conditions are satisfied

#### Scenario: `optional` is set to false

- **WHEN** a step declares `optional = false`
- **THEN** the engine treats the step as required (equivalent to omitting the field) and executes it on every pass

### Requirement: Steps MUST reference neurotypes by string ID

Each step MUST include an `id` (unique within the preset) and a `neurotype` (string identifier). The `neurotype` field MUST resolve to either a built-in neurotype or a user-defined entry under `[neurotypes.*]`.

#### Scenario: Step references a built-in neurotype

- **WHEN** a step declares `neurotype = "proposer"` and `proposer` is a built-in
- **THEN** the engine resolves the step to the built-in Proposer agent

#### Scenario: Step references a user-defined neurotype

- **WHEN** a step declares `neurotype = "historian"` and `[neurotypes.historian]` is defined in the same config
- **THEN** the engine resolves the step using the user-defined neurotype settings

#### Scenario: Step references an undefined neurotype

- **WHEN** a step declares `neurotype = "histroian"` (typo) and no such neurotype is defined or built-in
- **THEN** config loading fails with a validation error naming the offending step and the unknown neurotype ID

### Requirement: Step IDs MUST be unique within a preset

Within a single preset's `steps` array, every step's `id` MUST be unique. Duplicate IDs MUST cause config loading to fail.

#### Scenario: Preset contains duplicate step IDs

- **WHEN** a preset's `steps` array contains two entries with `id = "critique"`
- **THEN** config loading fails with a validation error naming the duplicate ID

### Requirement: User-defined neurotypes MUST declare their model adapter and prompt

Entries under `[neurotypes.<id>]` MUST include at minimum a `model` field (model adapter identifier) and a `system_prompt` field (string). Optional fields MAY include `description` and `temperature`.

#### Scenario: User-defined neurotype declares minimum required fields

- **WHEN** `[neurotypes.historian]` declares `model = "qwen3-30b"` and `system_prompt = "You are..."`
- **THEN** the neurotype is registered and addressable by ID `historian`

#### Scenario: User-defined neurotype omits `system_prompt`

- **WHEN** `[neurotypes.historian]` declares `model` but no `system_prompt`
- **THEN** config loading fails with a validation error naming the neurotype and the missing field
