## 1. Schema definition

- [ ] 1.1 Write `specs/topology/spec.md` with ADDED Requirements covering: section names, required preset metadata, step structure, neurotype reference resolution, optional-step opt-in, validation errors.
- [ ] 1.2 Add at least one Scenario per Requirement covering happy path and one failure mode.

## 2. Design notes

- [ ] 2.1 Document strict-by-default rationale and the explicit `optional: true` opt-out in `design.md`.
- [ ] 2.2 Document preset metadata (`name`, `description`, `best_for`) as a required schema element from the start, with rationale (avoids breaking change in Stage 3).

## 3. Validation

- [ ] 3.1 Run `openspec validate add-topology-spec --json` and resolve all errors.
- [ ] 3.2 Cross-check the schema against the eight neurotypes proposed in `add-eight-neurotypes` to ensure they fit without schema extensions.

## 4. Hand-off

- [ ] 4.1 Confirm Stage 1 changes (`add-eight-neurotypes`, `add-topology-runtime`) reference this spec by name.
- [ ] 4.2 (deferred to Stage 1) Implement TOML loader and validator in `@parliament/core`.
- [ ] 4.3 (deferred to Stage 3) Surface preset `name` / `description` / `best_for` in `@parliament/ui`.
