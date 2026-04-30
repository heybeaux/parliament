## Why

Once the engine runs multiple presets with twice as many neurotypes, end users need to (a) pick a preset and (b) understand what just happened in their deliberation. The current UI shows transcripts but no signal about *how* the deliberation evolved — whether the room converged, when the RedAgent broke consensus, which agent shifted the synthesis the most.

The user is the audience here, not researchers. This change is about making Parliament legible at the desk, not about producing publishable metrics.

## What Changes

- `@parliament/ui` gains a **preset picker** in the New Deliberation form: dropdown showing each preset's `name`, `description`, and `best_for` (from the topology spec's required metadata).
- The Timeline view gets **per-turn enrichment**: each agent's contribution shows model name, neurotype posture, word count, and a tiny convergence delta vs. the prior synthesis.
- A new **observability panel** (separate inspection view) shows:
  - Confidence sparkline across the deliberation.
  - Residue evolution (how much disagreement persisted round to round).
  - RedAgent injection events.
  - Sentry echo-collapse warnings.
- Both surfaces — per-turn enrichment AND the separate panel — exist. Per-turn enrichment is for the read-along experience; the panel is for the "wait, what happened on round 3?" inspection.

## Capabilities

### New Capabilities
- `observability-ui`: User-facing surfaces for inspecting a deliberation: preset picker for input, enriched Timeline for read-along, observability panel for retrospective.

### Modified Capabilities
<!-- None — additive UI only. The existing Timeline and TranscriptList components remain functional with their current contracts. -->

## Impact

- **@parliament/ui**: new preset picker component; Timeline component gains per-turn enrichment props; new observability panel component.
- **@parliament/server**: deliberation response and `getDeliberation` endpoint MUST include preset metadata, per-turn convergence deltas, and RedAgent/Sentry event annotations. (This is a server contract change but additive — old clients keep working with the existing fields.)
- **@parliament/core**: scoring already produces residue and OSI; this change exposes them through the API rather than computing anything new.
- **Roadmap**: Stage 3. Depends on `add-topology-runtime` (preset metadata must exist) and `add-eight-neurotypes` (neurotype postures need labels).
