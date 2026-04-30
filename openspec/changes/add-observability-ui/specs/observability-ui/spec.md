## ADDED Requirements

### Requirement: UI MUST provide a preset picker on the New Deliberation form

The New Deliberation form MUST include a preset picker that lists all presets the server exposes via `GET /presets`. Each preset's `name`, `description`, and `best_for` fields MUST be visible to the user before they submit.

#### Scenario: User opens the New Deliberation form

- **WHEN** the form mounts and `GET /presets` returns six presets
- **THEN** the picker shows six options, each rendering `name`, `description`, and `best_for`

#### Scenario: User submits without selecting a preset

- **WHEN** the user submits without changing the picker selection
- **THEN** the request uses the active preset from server config (returned as `defaultPreset` in `GET /presets`)

#### Scenario: Server exposes a user-defined preset

- **WHEN** `parliament.toml` adds a custom preset and the server reloads
- **THEN** the next `GET /presets` call returns it, and the picker lists it alongside built-ins without any UI rebuild

### Requirement: Server MUST expose a `GET /presets` endpoint

The server MUST expose `GET /presets` returning all available presets and the active default. The response MUST include each preset's `name`, `description`, `best_for`, and `id`. The response MUST also include `defaultPreset` (the active preset's `id`).

#### Scenario: Client requests preset list

- **WHEN** a client sends `GET /presets`
- **THEN** the response is `200 OK` with body shape `{ presets: [{ id, name, description, best_for }], defaultPreset: <id> }`

### Requirement: Deliberation response MUST include enrichment fields per turn

Every turn record returned by the deliberation endpoints MUST include `model_name`, `neurotype_posture`, `word_count`, and `convergence_delta` in addition to the existing fields.

#### Scenario: Client receives a deliberation result

- **WHEN** a client fetches a deliberation
- **THEN** every turn includes `model_name`, `neurotype_posture`, `word_count`, and `convergence_delta`, with `convergence_delta` set to `0` for the first turn

#### Scenario: Old client parses a new response

- **WHEN** a UI build that predates this change parses a new-format deliberation response
- **THEN** parsing succeeds because the new fields are additive (no existing field is renamed or removed)

### Requirement: Deliberation response MUST include an events array

The deliberation result MUST include `events[]` capturing RedAgent injections and Sentry echo-collapse warnings. Each event MUST include `round`, `kind`, and `message`.

#### Scenario: Deliberation runs without triggering any events

- **WHEN** a deliberation completes with no RedAgent injection and no Sentry warning
- **THEN** the response includes `events: []`

#### Scenario: Sentry detects echo collapse mid-deliberation

- **WHEN** the Sentry emits an echo-collapse warning during round 3
- **THEN** the response includes an event `{ round: 3, kind: "sentry.echo", message: <description> }`

### Requirement: Timeline turn cards MUST surface enrichment quietly

Each turn card in the Timeline MUST display `model_name`, `neurotype_posture`, and `word_count` without competing with the transcript text. The `convergence_delta` MUST be displayed as a small badge with sign-aware formatting.

#### Scenario: Turn card renders with positive convergence

- **WHEN** a turn has `convergence_delta = 0.12`
- **THEN** the card shows a `+0.12` badge styled as a positive-direction indicator

#### Scenario: Turn card renders with negative convergence

- **WHEN** a turn has `convergence_delta = -0.08`
- **THEN** the card shows a `-0.08` badge styled as a divergence indicator

### Requirement: UI MUST provide an observability panel toggle

The deliberation view MUST include a toggle that opens an observability panel. The panel MUST render: a confidence sparkline, a residue-per-round chart, and an event list. The panel MUST be closed by default.

#### Scenario: User toggles the panel open

- **WHEN** the user clicks the observability toggle on a completed deliberation
- **THEN** the panel renders sparkline, residue chart, and event list using only data already in the deliberation response

#### Scenario: Deliberation has no events

- **WHEN** the panel opens for a deliberation with `events: []`
- **THEN** the event list renders an empty-state message (e.g., "No interventions recorded") rather than disappearing

### Requirement: Plain-language labels MUST be used for user-facing metrics

The observability panel MUST use plain-language labels for residue, convergence delta, and OSI. The original metric names MUST be exposed via tooltip or aria-label for users who want them.

#### Scenario: Panel labels residue

- **WHEN** the panel renders the residue chart
- **THEN** the chart's title is `Disagreement remaining` (or equivalent plain-language phrasing) and a tooltip exposes the term `residue`

#### Scenario: Panel labels convergence delta

- **WHEN** the panel renders the convergence sparkline
- **THEN** the chart's title uses plain language (e.g., `Room movement`) and a tooltip exposes the term `convergence delta`
