## ADDED Requirements

### Requirement: Ideate is a top-level mode parallel to deliberate

The system MUST provide an `ideate` mode parallel to `deliberate`, accessible via the CLI command `parliament ideate "<idea>"` and the HTTP route `POST /ideate`. The two modes MUST run independently — invoking one MUST NOT modify state, configuration, or transcripts belonging to the other.

#### Scenario: CLI ideate command exists

- **WHEN** a user runs `parliament ideate --help`
- **THEN** the CLI prints usage including `--mode` and `--style` flags and exits with code 0

#### Scenario: HTTP /ideate route exists

- **WHEN** a client sends `POST /ideate` with a JSON body `{ "idea": "..." }`
- **THEN** the server starts an ideation run and responds with `{ "id": "...", "status": "running" }`

#### Scenario: Ideate does not affect deliberation transcripts

- **WHEN** an ideation run completes
- **THEN** no rows in the `deliberations` table are inserted, modified, or deleted as a result of the ideation

### Requirement: Ideate supports three sub-modes

The system MUST support exactly three ideate sub-modes: `cooperative`, `adversarial`, and `full`. Any other value of `mode` MUST be rejected with a 400 response (HTTP) or non-zero exit (CLI). Default sub-mode when omitted is `cooperative`.

#### Scenario: Default sub-mode is cooperative

- **WHEN** a client calls `POST /ideate` with `{ "idea": "..." }` and no `mode` field
- **THEN** the run executes the cooperative sub-mode

#### Scenario: Unknown sub-mode is rejected

- **WHEN** a client calls `POST /ideate` with `{ "idea": "...", "mode": "scrum" }`
- **THEN** the server responds with HTTP 400 and an error listing the three valid sub-modes

### Requirement: Ideate supports two contribution styles

The system MUST support exactly two contribution styles: `individual` (parallel) and `collective` (sequential). Default style is `collective`. The style MUST be orthogonal to the sub-mode: any combination of sub-mode and style MUST be valid.

#### Scenario: Default style is collective

- **WHEN** a client calls `POST /ideate` with no `style` field
- **THEN** the cooperative-build phase runs sequentially, each agent seeing prior turns

#### Scenario: Individual style runs in parallel

- **WHEN** a client calls `POST /ideate` with `{ "idea": "...", "style": "individual" }`
- **THEN** the cooperative-build phase runs all agents concurrently, each seeing only the original idea

### Requirement: Adversarial agents MUST emit structured problem-and-fix output

In `adversarial` and `full` sub-modes, each adversarial agent's output MUST be parsed as JSON conforming to the schema `{ "problems": [{ "problem": string, "proposed_fix": string }, ...] }`. If parsing fails, the orchestrator MUST re-prompt the same agent once with a stricter JSON-only instruction. If the second attempt also fails, the raw prose output MUST be preserved in the transcript and treated as best-effort input to the rebuttal and synthesis phases.

#### Scenario: Well-formed adversarial output

- **WHEN** an adversarial agent emits valid JSON with at least one problem-fix pair
- **THEN** the parsed problems are written to the phase transcript and passed to the rebuttal phase

#### Scenario: Adversarial output requires one retry

- **WHEN** an adversarial agent emits prose on the first attempt and valid JSON on the retry
- **THEN** the retry result is used and the transcript records both attempts

#### Scenario: Adversarial output fails twice

- **WHEN** an adversarial agent emits prose on both attempts
- **THEN** the run continues; the prose is recorded; the rebuttal phase prompt MUST include the prose verbatim and the synthesizer MUST be informed the input is unstructured

### Requirement: Adversarial and full sub-modes MUST run a rebuttal loop capped at 2 rounds

In `adversarial` and `full` sub-modes, after the adversarial-critique phase, the system MUST run a rebuttal phase. The rebuttal phase MUST run at least 1 round and at most 2 rounds. After 2 rounds, synthesis MUST proceed regardless of unresolved disagreements. The cap is fixed in code and MUST NOT be configurable in this change.

#### Scenario: First rebuttal round always runs

- **WHEN** the adversarial-critique phase produces at least one problem
- **THEN** at least one rebuttal round runs before synthesis

#### Scenario: Hard cap at 2 rounds

- **WHEN** 2 rebuttal rounds have completed
- **THEN** synthesis runs immediately, regardless of remaining unresolved problems

### Requirement: Cooperative sub-mode does not run adversarial or rebuttal phases

In the `cooperative` sub-mode, the system MUST run only the cooperative-build phase followed by synthesis. It MUST NOT run an adversarial-critique phase or a rebuttal phase.

#### Scenario: Cooperative run phases

- **WHEN** an ideation runs with `mode = "cooperative"`
- **THEN** the persisted phases array contains exactly two phase records: `cooperative-build` and `synth`

### Requirement: Full sub-mode runs all phases with the full lineup

In the `full` sub-mode, the system MUST run cooperative-build, adversarial-critique, rebuttal (1–2 rounds), and synthesis. The lineup MUST default to all 8 frontier models (4 closed + 4 open) unless overridden in `[ideate.lineup]`.

#### Scenario: Full mode phase ordering

- **WHEN** an ideation runs with `mode = "full"` and adversarial output produces problems
- **THEN** the phase records appear in order: `cooperative-build`, `adversarial-critique`, `rebuttal-1`, `rebuttal-2` (if needed), `synth`

#### Scenario: Full mode default lineup includes all 8 models

- **WHEN** an ideation runs with `mode = "full"` and no `[ideate.lineup]` overrides exist
- **THEN** the resolved lineup includes Opus 4.6, Sonnet 4.6, GPT-5, Gemini 2.5 Pro, Qwen, DeepSeek, Mistral, and Nemotron

### Requirement: Default lineup is encoded in core; TOML overrides are strict-by-default

The default lineup for each sub-mode MUST be defined as TypeScript constants in `@parliament/core`. The `[ideate.lineup]` section in `parliament.toml` MAY override individual roles. Override semantics MUST be strict-by-default: an override REPLACES the default for that role; absence falls back to the default. Merging is NOT supported.

#### Scenario: No TOML override uses defaults

- **WHEN** `parliament.toml` has no `[ideate.lineup]` section
- **THEN** the resolved lineup matches the in-code defaults exactly

#### Scenario: Per-role TOML override replaces only that role

- **WHEN** `parliament.toml` defines `[ideate.lineup.cooperative.proposer]` with model `X` and no other lineup entries
- **THEN** the cooperative team's proposer uses model `X` and all other roles use their defaults

### Requirement: Cooperative and adversarial sub-modes default to closed-team lineup; full uses all 8

When `[ideate.lineup]` does not override the team set, the system MUST default `cooperative` and `adversarial` sub-modes to the 4 closed-team models, and `full` to all 8 models.

#### Scenario: Cooperative default team

- **WHEN** an ideation runs with `mode = "cooperative"` and no lineup overrides
- **THEN** the cooperative-build phase agents are drawn from the 4 closed-team models only

#### Scenario: Full default team

- **WHEN** an ideation runs with `mode = "full"` and no lineup overrides
- **THEN** the cooperative-build phase agents include all 8 models (closed + open)

### Requirement: Synthesizer routing differs by sub-mode

The synthesizer model MUST default to Opus 4.6 (`anthropic/claude-opus-4-6`) for `cooperative` and `adversarial` sub-modes, and Gemini 2.5 Pro (`google/gemini-2.5-pro`) for `full`. The user MAY override per sub-mode via `[ideate.synth]`.

#### Scenario: Cooperative synth defaults to Opus 4.6

- **WHEN** an ideation runs with `mode = "cooperative"` and no `[ideate.synth]` overrides
- **THEN** the synthesizer agent uses model `anthropic/claude-opus-4-6`

#### Scenario: Full synth defaults to Gemini 2.5 Pro

- **WHEN** an ideation runs with `mode = "full"` and no `[ideate.synth]` overrides
- **THEN** the synthesizer agent uses model `google/gemini-2.5-pro`

#### Scenario: Synth override per sub-mode

- **WHEN** `parliament.toml` sets `[ideate.synth] full = "anthropic/claude-opus-4-6"`
- **THEN** a `mode = "full"` run uses Opus 4.6 for synthesis instead of Gemini 2.5 Pro

### Requirement: Full sub-mode MUST require explicit cost confirmation

The system MUST refuse to run `full` mode without explicit caller confirmation. The HTTP API MUST reject `POST /ideate` with `{ "mode": "full" }` and no `confirm: true` field, returning HTTP 400 with a message describing the cost characteristics. The CLI MUST print a token+cost estimate and prompt for `y` before running, unless `--yes` (or `-y`) is passed.

#### Scenario: HTTP full mode without confirm

- **WHEN** a client calls `POST /ideate` with `{ "idea": "...", "mode": "full" }` and no `confirm` field
- **THEN** the server responds with HTTP 400 and an error indicating `confirm: true` is required

#### Scenario: HTTP full mode with confirm

- **WHEN** a client calls `POST /ideate` with `{ "idea": "...", "mode": "full", "confirm": true }`
- **THEN** the server starts the ideation run

#### Scenario: CLI full mode interactive prompt

- **WHEN** a user runs `parliament ideate --mode=full "..."` interactively without `--yes`
- **THEN** the CLI prints a cost estimate and waits for input; only `y` (case-insensitive) proceeds; any other input aborts with exit code 0

#### Scenario: CLI full mode with --yes

- **WHEN** a user runs `parliament ideate --mode=full --yes "..."`
- **THEN** the run starts without an interactive prompt

### Requirement: Ideation transcripts MUST persist to a dedicated `ideations` table

The system MUST persist ideation runs in a SQLite table named `ideations`, separate from the `deliberations` table. Each row MUST include at minimum: id, created_at, idea, mode, style, status, resolved lineup, ordered phase records, synthesis output, and any error.

#### Scenario: Run creates a row

- **WHEN** an ideation run starts
- **THEN** a row is inserted in `ideations` with status `running` and the resolved lineup serialized as JSON

#### Scenario: Run completes successfully

- **WHEN** an ideation run completes
- **THEN** the row's status becomes `complete`, the synthesis JSON is populated, and all phase records are present in the phases array

#### Scenario: Run fails mid-phase

- **WHEN** a phase fails with a provider error
- **THEN** the row's status becomes `error`, the error field captures the failure, and the partial phases array is preserved

### Requirement: GET /ideate/:id MUST return the run record

The system MUST expose `GET /ideate/:id` returning the full row for the given ideation ID, including resolved lineup, phase records, and synthesis. If the ID does not exist, the server MUST respond with HTTP 404.

#### Scenario: Polling a running ideation

- **WHEN** a client calls `GET /ideate/:id` for a run in progress
- **THEN** the response includes the current phase records collected so far and `status: "running"`

#### Scenario: Unknown ID

- **WHEN** a client calls `GET /ideate/:id` for an ID that does not exist
- **THEN** the server responds with HTTP 404

### Requirement: CLI MUST expose a way to print the resolved lineup

The CLI MUST support `parliament ideate --print-lineup [--mode=...]` that resolves and prints the lineup that would be used (defaults plus any TOML overrides), without actually running an ideation.

#### Scenario: Print lineup for default mode

- **WHEN** a user runs `parliament ideate --print-lineup`
- **THEN** the CLI prints the resolved cooperative-mode lineup, including each role's model ID, and exits with code 0 without making any model calls
