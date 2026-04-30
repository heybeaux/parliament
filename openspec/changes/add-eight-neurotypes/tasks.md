## 1. Agent implementations

- [ ] 1.1 Implement `HistorianAgent` (temporal-past posture).
- [ ] 1.2 Implement `ForecasterAgent` (temporal-future posture).
- [ ] 1.3 Implement `PragmatistAgent` (constraint-first posture).
- [ ] 1.4 Implement `SteelmannerAgent` (charitable-reconstruction posture).
- [ ] 1.5 Implement `EmpiricistAgent` (evidence-first posture).
- [ ] 1.6 Implement `LateralistAgent` (cross-domain analogy posture).
- [ ] 1.7 Implement `TranslatorAgent` (compression / assumption-surfacing posture).
- [ ] 1.8 Implement `DevilsAdvocateAgent` (contrarian-to-consensus posture).

## 2. Registry & wiring

- [ ] 2.1 Register all eight neurotypes in the built-in registry under stable string IDs.
- [ ] 2.2 Confirm IDs match those referenced in `add-topology-runtime` presets.

## 3. Tests

- [ ] 3.1 Unit test that each agent produces output respecting its word cap.
- [ ] 3.2 Unit test that the Devil's Advocate disagrees with the *current* synthesis, not a hardcoded position.
- [ ] 3.3 Integration test running a one-round deliberation that includes all eight neurotypes.

## 4. Documentation

- [ ] 4.1 Add a `docs/neurotypes.md` table listing each ID, posture, system prompt summary, and recommended use.
- [ ] 4.2 (deferred to Stage 3) Surface this table in the UI's preset picker tooltip.
