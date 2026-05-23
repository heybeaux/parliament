## ADDED Requirements

### Requirement: Idea-level dedupe phase runs between cooperative-build and adversarial-critique

The system MUST run an idea-level dedupe phase after the cooperative-build phase emits drafts and before the adversarial-critique phase begins. The dedupe phase MUST embed each draft, compute pairwise cosine similarity, and collapse any pair whose similarity is greater-than-or-equal-to the configured threshold (default `0.85`) into a single surviving draft. The survivor MUST be the draft with higher author confidence; on equal confidence, the longer draft. The phase MUST emit a `phase.dedupe` event with `{ kept, merged_into }` and MUST append a `dedupe` record to `ideations.phases`.

#### Scenario: Dedupe runs after cooperative and before adversarial

- **WHEN** an ideation runs in `adversarial` or `full` sub-mode with `dedupe` enabled
- **THEN** the persisted phases array contains a `dedupe` entry positioned after `cooperative-build` and before `adversarial-critique`

#### Scenario: Pairs at-or-above threshold collapse

- **WHEN** two cooperative drafts have cosine similarity `>= dedupe_threshold`
- **THEN** the lower-confidence (or shorter, on ties) draft is recorded in `merged_into` mapping to the survivor's ID, and only the survivor proceeds to adversarial-critique

#### Scenario: Threshold of 1.0 collapses only exact matches

- **WHEN** an ideation runs with `dedupe_threshold = 1.0`
- **THEN** drafts collapse only when their cosine similarity is exactly 1.0

### Requirement: Dedupe embedding provider falls back from local to cloud and soft-fails

The system MUST attempt embedding via local `engram-embed` at `http://localhost:8080` first. On local failure, the system MUST fall back to Engram Cloud at `https://api.openengram.ai`. If both providers fail, the system MUST emit a `phase.warning` event capturing both errors, MUST skip dedupe (passing cooperative drafts through unchanged), and MUST NOT fail the ideation.

#### Scenario: Local provider succeeds

- **WHEN** local `engram-embed` returns embeddings successfully
- **THEN** the cloud provider is not contacted and the `dedupe` phase record names the local provider used

#### Scenario: Local fails, cloud succeeds

- **WHEN** local `engram-embed` errors and Engram Cloud returns embeddings successfully
- **THEN** the dedupe phase completes using cloud embeddings and the phase record names the cloud provider used

#### Scenario: Both providers fail

- **WHEN** both local and cloud embedding calls error
- **THEN** the orchestrator emits `phase.warning`, skips dedupe, passes all cooperative drafts unchanged to the next phase, and the ideation continues to completion

### Requirement: critique_cycles is a first-class request parameter orthogonal to sub-mode

The system MUST accept an optional `critique_cycles` field on `POST /ideate` with values `0` or `1`. Defaults MUST be: `0` for `cooperative` sub-mode, `1` for `adversarial` and `full` sub-modes. The parameter MUST be orthogonal to sub-mode — any valid sub-mode combined with `critique_cycles ∈ {0, 1}` is a valid request. Values greater than `1` MUST be rejected with HTTP 400 and the message `"critique_cycles is hard-capped at 1 in v1"`.

#### Scenario: critique_cycles = 0 skips adversarial and defense phases

- **WHEN** a client calls `POST /ideate` with `{ "mode": "full", "critique_cycles": 0 }`
- **THEN** the run executes cooperative-build, dedupe, and synth — and the phases array contains no `adversarial-critique` or `defense` entries

#### Scenario: critique_cycles > 1 is rejected

- **WHEN** a client calls `POST /ideate` with `{ "critique_cycles": 2 }`
- **THEN** the server responds with HTTP 400 and the error message indicates the hard cap

#### Scenario: Default critique_cycles by sub-mode

- **WHEN** a client calls `POST /ideate` with `{ "mode": "cooperative" }` and no `critique_cycles`
- **THEN** the effective `critique_cycles` is `0`
- **WHEN** a client calls `POST /ideate` with `{ "mode": "adversarial" }` and no `critique_cycles`
- **THEN** the effective `critique_cycles` is `1`

### Requirement: defense_mode controls author response stance

The system MUST accept an optional `defense_mode` field on `POST /ideate` with values `address`, `double_down`, or `author_choice`. Default MUST be `author_choice`. The defense phase output MUST conform to the schema `{ defenses: [{ critique_id, stance: 'address'|'double_down', reasoning, draft_delta? }] }`. When `defense_mode` is `address` or `double_down`, the parser MUST reject any defense whose `stance` does not match the forced mode and MUST re-prompt once; on second failure the wrong-stance response is preserved in the transcript as best-effort and a `phase.warning` is emitted.

#### Scenario: author_choice produces mixed stances

- **WHEN** an ideation runs with `defense_mode = "author_choice"`
- **THEN** each defense entry's `stance` field reflects the author model's per-critique choice and MAY include both `address` and `double_down` stances within one run

#### Scenario: address mode forces revisions

- **WHEN** an ideation runs with `defense_mode = "address"`
- **THEN** every defense entry MUST have `stance = "address"`; any defense returned with `stance = "double_down"` triggers a single retry, then a `phase.warning` if the retry still fails

#### Scenario: double_down mode forces justifications

- **WHEN** an ideation runs with `defense_mode = "double_down"`
- **THEN** every defense entry MUST have `stance = "double_down"`; address-stance responses trigger the same retry-then-warn fallback

### Requirement: Defense phase replaces rebuttal phase with backward-compatible alias

The orchestrator phase previously named `rebuttal` MUST be renamed to `defense`. The internal function `runDefensePhase` is the canonical name. The export `runRebuttalPhase` MUST remain as a deprecated alias pointing at `runDefensePhase` for backward compatibility with external consumers.

#### Scenario: Defense phase appears in persisted phases

- **WHEN** an ideation runs in `adversarial` or `full` mode with `critique_cycles = 1`
- **THEN** the persisted phases array contains a `defense` entry (not `rebuttal`) after `adversarial-critique` and before `synth`

#### Scenario: Deprecated alias still resolves

- **WHEN** external code imports `runRebuttalPhase` from `@parliament/core`
- **THEN** the import resolves to the same function as `runDefensePhase`

### Requirement: Adversarial critique payload MUST include a dimension field

Each problem emitted by an adversarial agent MUST include a `dimension` field with one of: `ux`, `business`, `technical`, `market`, `legal`, `other`. The adversarial parser MUST reject any problem missing `dimension` or with a `dimension` value outside the enum, and MUST re-prompt once with a stricter instruction. On second failure, the prose fallback rules from `add-ideate-mode` apply.

#### Scenario: Well-formed critique includes dimension

- **WHEN** an adversarial agent emits a problem with `{ problem, proposed_fix, dimension: "ux" }`
- **THEN** the parsed problem is written to the transcript with its dimension preserved and passed to the defense phase and synthesizer

#### Scenario: Missing dimension triggers retry

- **WHEN** an adversarial agent's first attempt omits `dimension`
- **THEN** the orchestrator re-prompts once with a stricter schema instruction

#### Scenario: Unknown dimension value is rejected

- **WHEN** an adversarial agent emits `dimension: "vibes"`
- **THEN** the parser rejects the problem and triggers the standard retry-then-fallback path

### Requirement: Critique dedupe is forbidden at the request and code layers

The system MUST reject any `POST /ideate` request with `dedupe_critiques: true` (or any truthy value of that field) with HTTP 400 and the message `"critique dedupe disabled by design — multi-model perspective signal is preserved"`. No code path within `@parliament/core/src/ideate/` MAY apply cosine-collapse, semantic-merging, or any dedupe utility to critique problems.

#### Scenario: Request-level rejection

- **WHEN** a client calls `POST /ideate` with `{ "idea": "...", "dedupe_critiques": true }`
- **THEN** the server responds with HTTP 400 and the architectural-lock message

#### Scenario: Code-level assertion holds

- **WHEN** the `assertCritiquesNotDeduped()` test helper inspects the orchestrator's critique pipeline
- **THEN** no cosine-collapse or dedupe utility is invoked against critique problems anywhere in the flow

### Requirement: Server validates new ideate parameters

The server MUST validate the following constraints on `POST /ideate` body fields and reject violations with HTTP 400:

- `critique_cycles` MUST be `0` or `1` if present.
- `dedupe_threshold` MUST be a number in `[0, 1]` if present.
- `defense_mode` MUST be one of `address`, `double_down`, `author_choice` if present.
- `dedupe_critiques` MUST NOT be truthy.

#### Scenario: dedupe_threshold outside range is rejected

- **WHEN** a client calls `POST /ideate` with `{ "dedupe_threshold": 1.5 }`
- **THEN** the server responds with HTTP 400 indicating the valid range is `[0, 1]`

#### Scenario: unknown defense_mode is rejected

- **WHEN** a client calls `POST /ideate` with `{ "defense_mode": "punt" }`
- **THEN** the server responds with HTTP 400 listing the three valid values

### Requirement: CLI exposes the new ideate parameters as flags

The CLI MUST accept the flags `--critique-cycles 0|1`, `--defense-mode address|double_down|author_choice`, `--no-dedupe`, and `--dedupe-threshold <float>` on `parliament ideate`. Each flag MUST forward to the corresponding `POST /ideate` body field. Absent flags MUST be omitted from the request body so server-side defaults apply.

#### Scenario: --no-dedupe disables the dedupe phase

- **WHEN** a user runs `parliament ideate --no-dedupe "..."`
- **THEN** the request body sets `dedupe: false` and the persisted phases array contains no `dedupe` entry

#### Scenario: --print-lineup includes new settings

- **WHEN** a user runs `parliament ideate --print-lineup`
- **THEN** the CLI output additionally prints the resolved `dedupe` config, `defense_mode`, and `critique_cycles` settings

### Requirement: TOML loader supports [ideate.dedupe] and [ideate.defense]

The TOML loader MUST parse `[ideate.dedupe]` with fields `provider_order` (default `["local", "cloud"]`), `threshold` (default `0.85`), and `enabled` (default `true`). The loader MUST parse `[ideate.defense]` with field `mode` (default `"author_choice"`). Validation errors (unknown provider, out-of-range threshold, unknown defense mode) MUST surface at server boot.

#### Scenario: TOML overrides apply

- **WHEN** `parliament.toml` sets `[ideate.dedupe] threshold = 0.9` and a request omits `dedupe_threshold`
- **THEN** the effective threshold is `0.9`

#### Scenario: Request body wins over TOML

- **WHEN** `parliament.toml` sets `[ideate.dedupe] threshold = 0.9` and a request sets `dedupe_threshold: 0.95`
- **THEN** the effective threshold is `0.95`

#### Scenario: Invalid TOML errors at boot

- **WHEN** `parliament.toml` sets `[ideate.dedupe] threshold = 1.5`
- **THEN** the server fails to start with a clear error citing the invalid threshold

### Requirement: New phase records persist without schema migration

The `dedupe` and `defense` phase records MUST persist inside the existing `ideations.phases` JSON column. No new columns or tables are required. The phase record JSON for `dedupe` MUST include `kept`, `merged_into`, `threshold`, and `provider`. The phase record JSON for `defense` MUST include the parsed `defenses` array.

#### Scenario: Dedupe record persists

- **WHEN** a dedupe phase runs successfully
- **THEN** `ideations.phases` contains an entry of type `dedupe` with `{ kept, merged_into, threshold, provider }`

#### Scenario: Defense record persists

- **WHEN** a defense phase runs successfully
- **THEN** `ideations.phases` contains an entry of type `defense` with the full `defenses` array including per-critique `stance` and `reasoning`
