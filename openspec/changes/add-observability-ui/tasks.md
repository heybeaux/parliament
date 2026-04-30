## 1. Server contract additions

- [ ] 1.1 Extend deliberation response schema with `preset: { name, description, best_for }`.
- [ ] 1.2 Extend each turn record with `model_name`, `neurotype_posture`, `word_count`, and `convergence_delta` (number).
- [ ] 1.3 Add `events[]` to the deliberation result — array of `{ round, kind, message }` capturing RedAgent injections and Sentry echo-collapse warnings.
- [ ] 1.4 Confirm old UI clients still parse the response (additive only).

## 2. Preset picker

- [ ] 2.1 Build `PresetPicker` component fetching the registry from `GET /presets`.
- [ ] 2.2 Render each preset with `name` (bold), `description` (subtitle), `best_for` (small italic).
- [ ] 2.3 Wire into `NewDeliberation` so a chosen preset flows into `startDeliberation(topic, preset)`.
- [ ] 2.4 Default selection is the active preset from server config.

## 3. Per-turn Timeline enrichment

- [ ] 3.1 Add a tooltip/footer on each turn card showing `model_name`, `neurotype_posture`, `word_count`.
- [ ] 3.2 Render `convergence_delta` as a small badge: `+0.12` (move toward consensus) or `-0.08` (move away).
- [ ] 3.3 Visual language: muted by default, never block the transcript text.

## 4. Observability panel

- [ ] 4.1 Build `ObservabilityPanel` component, accessible via a tab or detail-view toggle.
- [ ] 4.2 Render confidence sparkline over rounds (one line per neurotype that participated).
- [ ] 4.3 Render residue evolution as a small bar chart per round.
- [ ] 4.4 Render an event list for RedAgent injections and Sentry echo warnings, anchored to round numbers.

## 5. Tests

- [ ] 5.1 Component tests: PresetPicker renders all three metadata fields.
- [ ] 5.2 Component tests: Timeline turn card shows enrichment without breaking the transcript layout.
- [ ] 5.3 Component tests: ObservabilityPanel renders with empty event list (deliberation without RedAgent injection).
- [ ] 5.4 Server response shape test: every deliberation result includes the new fields with sensible defaults.

## 6. Documentation

- [ ] 6.1 Update README screenshot section to show the picker and panel.
- [ ] 6.2 Document the observability panel's metrics in plain language (no research jargon).
