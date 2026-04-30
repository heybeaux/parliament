## ADDED Requirements

### Requirement: Built-in neurotype registry MUST include eight new postures

`@parliament/core` MUST register the following neurotype IDs as built-ins, in addition to the original five: `historian`, `forecaster`, `pragmatist`, `steelmanner`, `empiricist`, `lateralist`, `translator`, `devils-advocate`. Each MUST be addressable from a topology config by its kebab-case ID.

#### Scenario: Topology references a new built-in neurotype by ID

- **WHEN** a preset's step declares `neurotype = "historian"` and no user-defined `[neurotypes.historian]` exists
- **THEN** the engine resolves the step to the built-in HistorianAgent without error

#### Scenario: User-defined neurotype shadows a built-in

- **WHEN** `[neurotypes.historian]` is defined in `parliament.toml` AND `historian` is also a built-in
- **THEN** the user-defined version takes precedence; the engine emits an info-level log noting the shadow

### Requirement: Each new neurotype MUST embody a distinct cognitive posture

Every new neurotype's system prompt MUST instruct the model to adopt a posture distinct from the other neurotypes. Specifically:

- `historian` reasons from precedent and prior cases.
- `forecaster` reasons about second-order and downstream effects.
- `pragmatist` reasons from constraints and feasibility.
- `steelmanner` reconstructs the strongest version of an opposing view.
- `empiricist` demands evidence and flags untestable claims.
- `lateralist` reasons via cross-domain analogy.
- `translator` compresses for a non-expert audience and surfaces implicit assumptions.
- `devils-advocate` argues against the most recent convergent view in the deliberation.

#### Scenario: Empiricist responds to an unsupported claim

- **WHEN** the prior turn contains a claim with no cited evidence
- **THEN** the EmpiricistAgent's output names the unsupported claim and asks for the evidence that would settle it

#### Scenario: Devil's Advocate responds to a critique-heavy round

- **WHEN** the most recent two turns both argue against the Proposer's position
- **THEN** the DevilsAdvocateAgent argues *for* the Proposer's position (or against the critique itself), not against the Proposer

### Requirement: Each new neurotype MUST respect a configurable word cap

Each new agent's output MUST be enforced against a word cap. The default cap MUST be 200 words, matching the existing neurotypes. Output exceeding the cap MUST be truncated, and the agent's `AgentResult` MUST set `truncated = true`.

#### Scenario: Output respects the default cap

- **WHEN** an agent generates 180 words of output
- **THEN** the AgentResult has `content` containing all 180 words and `truncated = false`

#### Scenario: Output exceeds the default cap

- **WHEN** an agent generates 240 words of output
- **THEN** the AgentResult has `content` truncated to 200 words and `truncated = true`

### Requirement: New neurotype IDs MUST be stable

The eight registered IDs (`historian`, `forecaster`, `pragmatist`, `steelmanner`, `empiricist`, `lateralist`, `translator`, `devils-advocate`) MUST NOT be renamed without a follow-up change proposal. Renaming is a breaking change for user `parliament.toml` files.

#### Scenario: Future change attempts to rename `devils-advocate`

- **WHEN** a future change proposes renaming `devils-advocate` to `contrarian`
- **THEN** that change MUST include a deprecation alias retaining `devils-advocate` for at least one stage release
