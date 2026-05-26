## ADDED Requirements

### Requirement: Brainstorm is a top-level mode parallel to ideate and deliberate

The system MUST provide a `brainstorm` mode parallel to `ideate` and `deliberate`, accessible via the CLI command `parliament brainstorm "<prompt>"` and the HTTP routes `POST /brainstorm` and `POST /brainstorm/forge`. The brainstorm runtime MUST NOT call `runIdeation()` from `@parliament/core/ideate`.

#### Scenario: CLI brainstorm command exists

- **WHEN** a user runs `parliament brainstorm --help`
- **THEN** the CLI prints usage including `--forge`, `--k`, and `--ideas-per-author` flags and exits with code 0

#### Scenario: HTTP /brainstorm route exists

- **WHEN** a client sends `POST /brainstorm` with a JSON body `{ "prompt": "..." }`
- **THEN** the server starts a brainstorm run and responds with `{ "id": "...", "status": "running" }`

#### Scenario: HTTP /brainstorm/forge route exists

- **WHEN** a client sends `POST /brainstorm/forge` with a JSON body `{ "prompt": "..." }`
- **THEN** the server starts a brainstorm-with-forge run and responds with `{ "id": "...", "status": "running" }`

#### Scenario: Brainstorm does not affect ideation transcripts

- **WHEN** a brainstorm run completes
- **THEN** no rows in the `ideations` or `deliberations` tables are inserted, modified, or deleted as a result of the brainstorm

#### Scenario: Brainstorm orchestrator does not depend on ideate orchestrator

- **WHEN** the brainstorm orchestrator module is inspected
- **THEN** it MUST NOT import `runIdeation` from `@parliament/core/ideate/orchestrator`
- **AND** it MUST NOT register `runIdeation` as a callable downstream of any brainstorm phase

### Requirement: Brainstorm runs a fixed four-phase pipeline plus optional forge

The system MUST execute brainstorm phases in this order: `divergent-generation` → `idea-dedupe` → `idea-cluster` → `idea-rank`. When `mode` is `brainstorm/forge`, a fifth phase `forge-elaboration` MUST run after `idea-rank`. The phase order MUST NOT be configurable in this change.

#### Scenario: Plain brainstorm runs four phases

- **WHEN** a `POST /brainstorm` request completes
- **THEN** the persisted `phases[]` contains exactly four records with phase IDs in order: `divergent-generation`, `idea-dedupe`, `idea-cluster`, `idea-rank`

#### Scenario: Forge brainstorm runs five phases

- **WHEN** a `POST /brainstorm/forge` request completes
- **THEN** the persisted `phases[]` contains exactly five records with phase IDs in order: `divergent-generation`, `idea-dedupe`, `idea-cluster`, `idea-rank`, `forge-elaboration`

### Requirement: Divergent generation produces N×K structured ideas

The divergent-generation phase MUST run N divergent authors in parallel (N = lineup size, default 4). Each author MUST produce K ideas (K configurable via `ideas_per_author`, default 5). Each idea MUST include `title`, `one_liner`, `dimensions` (array of dimension tags), and `rationale` fields. The author's model ID MUST be recorded for each idea to enable author-aware judging downstream.

#### Scenario: All authors run in parallel

- **WHEN** the divergent-generation phase executes with 4 authors
- **THEN** all 4 author invocations are dispatched concurrently
- **AND** the phase record contains contributions from all 4 authors

#### Scenario: Each idea carries author identity

- **WHEN** the divergent-generation phase persists
- **THEN** every idea in the phase record has a non-empty `author_model` field matching the model that produced it

#### Scenario: Author returns malformed JSON on first attempt

- **WHEN** an author returns non-parseable output on the first attempt and valid JSON on retry
- **THEN** the retry result is used and the phase record notes `attempts: 2` for that author

#### Scenario: Author returns malformed JSON on both attempts

- **WHEN** an author returns non-parseable output on both attempts
- **THEN** the raw prose is preserved with `unstructured: true`
- **AND** the run continues; the affected ideas are excluded from the dedupe and rank phases

### Requirement: Idea-dedupe reuses the ideate dedupe primitive

The idea-dedupe phase MUST invoke `runDedupePhase` from `@parliament/core/ideate/dedupe.ts` and MUST NOT reimplement the cosine-collapse logic. The phase MUST be recorded as `phase: 'idea-dedupe'`. Soft-fail semantics MUST match ideate: if both embedding providers fail, the phase record carries `skipped: true` with a warning, and downstream phases proceed with un-deduped ideas.

#### Scenario: Dedupe collapses cross-author duplicates

- **WHEN** two authors produce ideas with cosine similarity above the threshold
- **THEN** the merge map collapses them into a single survivor
- **AND** the survivor's author identity is the author of the canonical (kept) idea

#### Scenario: Both embedding providers fail

- **WHEN** both local and cloud embedding providers fail during idea-dedupe
- **THEN** the phase record contains `skipped: true` and a warning
- **AND** the rank phase receives all un-deduped ideas

### Requirement: Idea-cluster groups survivors into thematic clusters

The idea-cluster phase MUST emit a cluster label for each surviving idea after dedupe. Cluster output is advisory: if the cluster model call fails, the phase record MUST carry a warning, every idea MUST be assigned `cluster: null`, and the run MUST continue.

#### Scenario: Successful cluster assignment

- **WHEN** the cluster model call succeeds
- **THEN** every surviving idea has a non-empty `cluster` field
- **AND** the phase record includes the cluster-label-to-idea-ID map

#### Scenario: Cluster call fails

- **WHEN** the cluster model call fails
- **THEN** every surviving idea has `cluster: null`
- **AND** the phase record contains a warning
- **AND** the rank phase still runs

### Requirement: Idea-rank uses independent judges with author-aware skip

The idea-rank phase MUST score each surviving idea using independent judges (configured in the brainstorm lineup, default 2 judges). Judges MUST run in parallel; they MUST NOT see each other's scores during scoring. When a judge's model ID equals an idea's `author_model`, that judge MUST be skipped for that idea. The final score per idea is the weighted sum (over criteria) of the average across non-skipped judges of per-criterion scores.

#### Scenario: Two judges score independently

- **WHEN** the rank phase runs with 2 judges
- **THEN** both judges are invoked in parallel
- **AND** neither judge's prompt includes the other judge's scores

#### Scenario: Judge skipped for own authored idea

- **WHEN** an idea was authored by a model that also serves as a judge
- **THEN** that judge MUST be skipped for that idea
- **AND** the idea's `judges_skipped` array includes that judge's model ID
- **AND** the score is computed from the remaining judge(s) only

#### Scenario: Both judges authored the same idea

- **WHEN** all judges for a brainstorm run are skipped for a given idea (because they all authored it)
- **THEN** the idea's `score` is `null`
- **AND** the idea's `judge_skipped: true` flag is set
- **AND** the idea is sorted to the end of the rank list

#### Scenario: Per-criterion scores are persisted

- **WHEN** the rank phase completes
- **THEN** the rank record contains per-idea per-criterion scores and rationales
- **AND** the weighted-sum final score is also persisted

#### Scenario: Deterministic tiebreak

- **WHEN** two ideas have identical final scores
- **THEN** they are ordered by ascending `idea_id`

### Requirement: Criteria set is locked at four values in v1

The criteria set used by judges MUST be exactly `{ novelty, feasibility, fit, evidence }`. Any request body or TOML attempting to add or remove criteria MUST be rejected with a 400 (HTTP) or non-zero exit (CLI). Weights across the four criteria are configurable via `[brainstorm.rank.weights]` and MUST sum to 1.0 within ±0.01.

#### Scenario: Default weights are equal

- **WHEN** no `[brainstorm.rank.weights]` block is present
- **THEN** each criterion has weight 0.25

#### Scenario: Custom weights validated

- **WHEN** `[brainstorm.rank.weights]` sets weights that do not sum to ~1.0
- **THEN** server boot fails with an explanatory error

#### Scenario: Adding a criterion is rejected

- **WHEN** a request includes `criteria: ['novelty', 'feasibility', 'fit', 'evidence', 'cost']`
- **THEN** the server responds 400 with a message naming the four locked criteria

### Requirement: Each idea has a deterministic idea_id

The system MUST assign each surviving idea an `idea_id` derived from a stable hash of its `(title, one_liner)` pair after dedupe. The same `(title, one_liner)` pair across reruns MUST produce the same `idea_id`. The hash algorithm MUST be deterministic and MUST NOT depend on run time, model nondeterminism, or random seeds.

#### Scenario: Same idea text yields same idea_id across runs

- **WHEN** two brainstorm runs each produce a surviving idea with title `"Foo"` and one-liner `"Bar"`
- **THEN** both runs report the same `idea_id` for that idea

#### Scenario: Different idea text yields different idea_id

- **WHEN** one idea has title `"Foo"` and another has title `"Foo "` (trailing space)
- **THEN** their `idea_ids` differ (no normalization beyond canonicalization rules documented in the implementation)

### Requirement: Forge elaboration runs only when invoked via /brainstorm/forge

The forge-elaboration phase MUST run when and only when `mode === 'brainstorm/forge'`. The phase MUST elaborate the top-K ideas (K configurable, default 3) in parallel. Forge MUST use a brainstorm-owned elaboration primitive (`elaborateIdea`) and MUST NOT call `runIdeation`.

#### Scenario: Plain brainstorm has no elaborations

- **WHEN** a `POST /brainstorm` run completes
- **THEN** the response `elaborations` field is `null`

#### Scenario: Forge produces top-K elaborations

- **WHEN** a `POST /brainstorm/forge` run completes with K=3
- **THEN** the response `elaborations` array contains exactly 3 entries
- **AND** each entry corresponds to a top-3 ranked idea
- **AND** each entry includes `idea_id`, `elaboration`, `model`, and `timestamp`

#### Scenario: Partial elaboration failure does not abort the run

- **WHEN** 1 of K elaborations fails
- **THEN** the surviving K-1 elaborations are persisted
- **AND** the failed elaboration is recorded with an error string in place of `elaboration`

### Requirement: Brainstorm runs persist to a dedicated brainstorms table

The system MUST persist brainstorm runs to a `brainstorms` table with columns `id`, `created_at`, `prompt`, `mode`, `status`, `lineup`, `phases`, `rankings`, `elaborations`, `error`. Brainstorm runs MUST NOT write to the `ideations` table. `GET /brainstorm/:id` MUST read only from `brainstorms` and MUST NOT fall back to `ideations`.

#### Scenario: Brainstorm run creates a brainstorms row

- **WHEN** a brainstorm run starts
- **THEN** a row in the `brainstorms` table exists with `status: 'running'`
- **AND** no row in `ideations` is created

#### Scenario: GET /brainstorm/:id returns 404 for ideations IDs

- **WHEN** a client requests `GET /brainstorm/<id>` where `<id>` is a valid `ideations` row ID
- **THEN** the server responds 404

### Requirement: The legacy alias routing MUST be removed

The implementation change MUST remove the existing `app.post('/brainstorm', handleIdeate)` and `app.post('/brainstorm/forge', handleIdeate)` route registrations from `packages/server/src/routes.ts`. These routes MUST be replaced by the new brainstorm-specific handlers.

#### Scenario: Brainstorm routes do not route to handleIdeate

- **WHEN** the server source is inspected after the implementation change
- **THEN** no route registration exists that maps `/brainstorm` or `/brainstorm/forge` to `handleIdeate`
