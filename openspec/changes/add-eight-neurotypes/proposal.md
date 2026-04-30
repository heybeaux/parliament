## Why

Parliament ships five neurotypes (Proposer, Skeptic, Synthesizer, RedAgent, Sentry). They cover the basic dialectic — propose, attack, reconcile, disrupt, monitor — but leave gaps. Most live deliberations end up sounding similar across topics because every voice is operating on the same axis (advocate vs. critic). The PNAS Nexus result is that *posture* diversity matters as much as *opinion* diversity.

This change introduces eight new neurotypes that span temporal posture, epistemic posture, and rhetorical posture. They're chosen so any topology can pull a balanced cast without overlap.

## What Changes

- Adds eight new agent classes to `@parliament/core`:
  - **Historian** — temporal posture (past). Grounds claims in precedent.
  - **Forecaster** — temporal posture (future). Projects second-order effects.
  - **Pragmatist** — epistemic posture (constraint-first). What's feasible, not what's ideal.
  - **Steelmanner** — rhetorical posture (charity). Reconstructs the strongest version of an opposing view.
  - **Empiricist** — epistemic posture (evidence-first). Demands data, flags claims that can't be tested.
  - **Lateralist** — rhetorical posture (analogy). Reasons via cross-domain comparison.
  - **Translator** — rhetorical posture (compression). Restates technical content for non-experts and surfaces hidden assumptions.
  - **Devil's Advocate** — rhetorical posture (contrarian). Argues *against* whatever the room agrees on, including opposing views.
- Each neurotype has a defined system prompt, expected word cap, and posture description.
- Built-in registry exposes them by string ID for use in topology configs.

## Capabilities

### New Capabilities
- `neurotypes`: The roster of agent personas Parliament ships out of the box, each with a fixed posture, system prompt, and registry ID.

### Modified Capabilities
<!-- None — additive only. The original five neurotypes (proposer, skeptic, synthesizer, red-agent, sentry) are unchanged. -->

## Impact

- **@parliament/core**: eight new files under `src/agents/`, registry update.
- **No config breakage**: existing `parliament.toml` files don't reference these IDs, so behavior is unchanged until a user opts into a topology that uses them.
- **Depends on**: nothing. Can land before `add-topology-runtime` (the agents work standalone; the runtime change wires them into presets).
- **Roadmap**: Stage 1.
