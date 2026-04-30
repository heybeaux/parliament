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

Each preset definition MUST include `name`, `description`, and `best_for` fields. All three are required string fields. Loading MUST fail with a validation error if any preset omits any of these fields. This requirement applies uniformly to built-in presets and user-defined presets in `parliament.toml`; there is no metadata-exempt preset class.

#### Scenario: Preset declares all required metadata

- **WHEN** a preset declares `name = "Debate"`, `description = "..."`, `best_for = "..."` plus a `steps` array
- **THEN** the preset is accepted as valid

#### Scenario: Preset omits `best_for`

- **WHEN** a preset defines `name` and `description` but not `best_for`
- **THEN** config loading fails with a validation error naming the offending preset and the missing field

#### Scenario: User-defined preset omits metadata

- **WHEN** `parliament.toml` declares `[topology.presets.my-flow]` with a `steps` array but no `name`, `description`, or `best_for`
- **THEN** config loading fails with a validation error naming `my-flow` and listing the missing metadata fields

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

### Requirement: Step IDs MUST be kebab-case

Every step `id` MUST match the regex `^[a-z][a-z0-9-]*$` — lowercase ASCII letters, digits, and hyphens, beginning with a letter. Step IDs that do not match this pattern MUST cause config loading to fail with a validation error naming the offending step and the rule violated.

#### Scenario: Step ID is valid kebab-case

- **WHEN** a step declares `id = "devils-advocate"`
- **THEN** the step ID is accepted

#### Scenario: Step ID uses snake_case

- **WHEN** a step declares `id = "devils_advocate"`
- **THEN** config loading fails with a validation error citing the kebab-case rule and the offending ID

#### Scenario: Step ID uses PascalCase

- **WHEN** a step declares `id = "DevilsAdvocate"`
- **THEN** config loading fails with a validation error citing the kebab-case rule and the offending ID

#### Scenario: Step ID begins with a digit

- **WHEN** a step declares `id = "1critique"`
- **THEN** config loading fails with a validation error citing the kebab-case rule and the offending ID

### Requirement: Unknown active preset MUST surface a "did you mean" suggestion

When `[topology] active` resolves to a preset ID that is not defined (neither built-in nor user-defined), config loading MUST fail with an error that lists the available preset IDs AND, when at least one available ID is within Levenshtein distance 2 of the unknown name, includes a "did you mean `<closest>`?" suggestion. Suggestion computation MUST run only at config-load time, not on every deliberation.

#### Scenario: Active preset name has a near match

- **WHEN** `parliament.toml` contains `[topology] active = "debat"` and `debate` is an available preset
- **THEN** config loading fails with an error of the form `unknown preset "debat" — did you mean "debate"? Available presets: [debate, star-chamber, ...]`

#### Scenario: Active preset name has no near match

- **WHEN** `parliament.toml` contains `[topology] active = "xyzzy"` and no available preset is within edit distance 2
- **THEN** config loading fails with an error listing the available presets but omitting the "did you mean" suggestion

### Requirement: User-defined neurotypes MUST declare their model adapter and prompt

Entries under `[neurotypes.<id>]` MUST include at minimum a `model` field (model adapter identifier) and a `system_prompt` field (string). Optional fields MAY include `description` and `temperature`. When `temperature` is omitted, the engine MUST apply a default of `0.7`.

#### Scenario: User-defined neurotype declares minimum required fields

- **WHEN** `[neurotypes.historian]` declares `model = "qwen3-30b"` and `system_prompt = "You are..."`
- **THEN** the neurotype is registered and addressable by ID `historian`

#### Scenario: User-defined neurotype omits `system_prompt`

- **WHEN** `[neurotypes.historian]` declares `model` but no `system_prompt`
- **THEN** config loading fails with a validation error naming the neurotype and the missing field

#### Scenario: User-defined neurotype omits `temperature`

- **WHEN** `[neurotypes.historian]` declares `model` and `system_prompt` but no `temperature`
- **THEN** the neurotype is registered with `temperature = 0.7`

### Requirement: Topology presets MAY declare an additive `parallel_steps` block

A preset MAY declare an optional `parallel_steps` field alongside its sequential `steps` array. The field is purely additive: a preset that omits `parallel_steps` MUST behave identically to a sequential-only preset, with no warnings or behavior changes.

When present, the field MUST be parsed as a list whose entries share the same shape as a sequential step (`id`, `neurotype`, `optional`). Step IDs MUST be globally unique across both `steps` and `parallel_steps`; duplicates MUST cause config loading to fail with the same `duplicate_step_id` validation class used for sequential duplicates.

The Stage 4 capability `topology-parallel` (see `add-jury-parallel/specs/topology-parallel/spec.md`) governs the runtime semantics — read-only snapshot, registration-order merge, block-level timeout, and `parallel_group` annotation. This requirement only governs schema admission.

#### Scenario: Preset omits `parallel_steps`

- **WHEN** a preset declares `steps` but no `parallel_steps`
- **THEN** the preset validates and runs identically to pre-Stage-4 sequential-only presets

#### Scenario: Preset declares both blocks

- **WHEN** a preset declares both `steps = [proposer, synthesizer]` and `parallel_steps = [skeptic, empiricist, steelmanner, devils-advocate]`
- **THEN** the loader admits the preset; runtime semantics are governed by `topology-parallel`

#### Scenario: Step ID collision across blocks

- **WHEN** a preset declares `steps = [{id = "critique", neurotype = "skeptic"}]` and `parallel_steps = [{id = "critique", neurotype = "empiricist"}]`
- **THEN** config loading fails with `duplicate_step_id`, naming both block locations
