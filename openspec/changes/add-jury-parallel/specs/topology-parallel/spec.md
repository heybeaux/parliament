## ADDED Requirements

### Requirement: Topology schema MUST accept an optional `parallel_steps` block

The topology configuration schema MUST accept an optional `parallel_steps` field on a preset definition. When present, the field MUST be parsed as a list of steps that execute concurrently against a shared read-only snapshot of the blackboard. When absent, the preset MUST validate as a sequential-only preset without warnings.

#### Scenario: Preset declares both sequential and parallel steps

- **WHEN** a preset declares `steps = [proposer, synthesizer]` and `parallel_steps = [skeptic, empiricist, steelmanner, devils-advocate]`
- **THEN** the executor runs Proposer first, then runs all four parallel-step agents concurrently against the same blackboard snapshot, then runs Synthesizer

#### Scenario: Preset omits `parallel_steps`

- **WHEN** a preset has no `parallel_steps` field
- **THEN** the preset behaves identically to a sequential-only preset (the field is optional and additive)

### Requirement: Parallel-step agents MUST execute against a read-only snapshot

When a parallel block executes, every agent in the block MUST read from the same blackboard snapshot taken at block start. Parallel-block agents MUST NOT see each other's output until the block completes.

#### Scenario: Two parallel agents run concurrently

- **WHEN** Skeptic and Empiricist execute in the same parallel block
- **THEN** neither agent's prompt context contains the other agent's output, regardless of completion order

#### Scenario: Sequential step follows a parallel block

- **WHEN** a Synthesizer step runs after a parallel block of four critics
- **THEN** the Synthesizer's prompt context contains all four critics' outputs

### Requirement: Parallel-block results MUST be appended in registration order

After all agents in a parallel block complete, their results MUST be appended to the blackboard in the order declared in `parallel_steps`, not in completion order.

#### Scenario: Slow agent finishes after fast agent

- **WHEN** Skeptic (declared first) finishes after Empiricist (declared second)
- **THEN** the transcript shows Skeptic's turn before Empiricist's turn (registration order, not completion order)

### Requirement: Parallel block MUST apply a single block-level timeout

A parallel block MUST be governed by one timeout that bounds the whole block. If any agent in the block exceeds the timeout, the entire block MUST fail with an error naming the offending agent.

#### Scenario: One parallel agent exceeds the timeout

- **WHEN** the block timeout is 30 seconds and the Steelmanner agent has not produced output after 30 seconds
- **THEN** the block fails with an error message identifying Steelmanner as the slow agent; partial results are not committed to the blackboard

#### Scenario: All parallel agents complete within timeout

- **WHEN** every agent in the block produces output within the timeout
- **THEN** the block succeeds and all results are appended to the blackboard in registration order

### Requirement: Parallel turns MUST be annotated with a `parallel_group` field

Every turn produced inside a parallel block MUST include a `parallel_group` field carrying a group identifier shared by all siblings of that block.

#### Scenario: Jury block produces four sibling turns

- **WHEN** the Jury preset's parallel block completes with four turns
- **THEN** all four turns share the same `parallel_group` value, distinct from any other group's identifier

#### Scenario: Sequential turn outside any parallel block

- **WHEN** the Proposer turn is recorded as part of `steps` (sequential)
- **THEN** the Proposer turn has no `parallel_group` field, or has `parallel_group = null`

### Requirement: Step IDs MUST be unique across `steps` and `parallel_steps`

Within a single preset, every step ID across both `steps` and `parallel_steps` MUST be unique. Duplicate IDs MUST cause config loading to fail.

#### Scenario: Sequential and parallel steps share an ID

- **WHEN** a preset declares `steps = [{id: "critique", neurotype: "skeptic"}]` and `parallel_steps = [{id: "critique", neurotype: "empiricist"}]`
- **THEN** config loading fails with a validation error naming the duplicate ID and both step locations

### Requirement: Built-in `jury` preset MUST be registered

The runtime MUST register a built-in preset with `id = "jury"`. The Jury preset MUST run a sequential Proposer step, followed by a parallel block of `[skeptic, empiricist, steelmanner, devils-advocate]`, followed by a sequential Synthesizer step.

#### Scenario: Jury preset is selectable

- **WHEN** a user sets `[topology] active = "jury"` in `parliament.toml`
- **THEN** the engine resolves and runs the Jury preset successfully

#### Scenario: Jury preset metadata

- **WHEN** the registry exposes the Jury preset
- **THEN** the preset's metadata includes `name = "Jury"`, a non-empty `description`, and a `best_for` field describing the order-bias use case

### Requirement: Timeline UI MUST render parallel siblings as a group

When a deliberation transcript contains turns annotated with the same `parallel_group`, the Timeline UI MUST render those turns as a visual group (e.g., a row of sibling cards), distinct from sequential turns.

#### Scenario: Timeline renders Jury transcript

- **WHEN** the Timeline displays a Jury deliberation with one Proposer turn, four parallel critic turns, and one Synthesizer turn
- **THEN** the four critic turns render as a sibling group, separated visually from the surrounding Proposer and Synthesizer turns

#### Scenario: Timeline renders a pre-existing sequential transcript

- **WHEN** the Timeline displays an old transcript with no `parallel_group` annotations
- **THEN** every turn renders sequentially, identical to pre-Stage-4 behavior
