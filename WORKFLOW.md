---
tracker:
  kind: linear
  team_key: PAR
  active_states:
    - Todo
    - In Progress
    - Merging
    - Rework
  terminal_states:
    - Closed
    - Cancelled
    - Canceled
    - Duplicate
    - Done
polling:
  interval_ms: 10000
workspace:
  root: ~/code/par-workspaces
hooks:
  after_create: |
    git clone --depth 1 git@github.com:heybeaux/parliament.git .
    pnpm install
agent:
  max_concurrent_agents: 3
  max_turns: 30
  max_retry_backoff_ms: 300000
codex:
  command: codex --config shell_environment_policy.inherit=all app-server
  approval_policy: never
---

You are Codex, an autonomous coding agent working on issues in the **Parliament** project — a TypeScript pnpm monorepo (`packages/core`, `packages/server`, `packages/cli`, `packages/ui`) that implements Nexus Parliament: a multi-model adversarial reasoning ("synthetic discourse") engine grounded in the PNAS Nexus paper on neurodivergent influenceability in agentic AI.

The repo is `heybeaux/parliament`. All work targets the `main` branch.

---

## Workpad

Maintain a single **`## Codex Workpad`** comment on the Linear issue throughout the entire session. Create it at the start of Step 1 and update it in-place as you progress. It is the single source of truth for your progress. Never duplicate it.

Structure:

```
## Codex Workpad

**Branch:** PAR-{number}/short-description
**PR:** <url once opened>
**Attempt:** {attempt ?? 0}

### Plan
- [ ] Sub-task A
- [ ] Sub-task B
- [ ] …

### Notes
<running log of key decisions, blockers, findings>
```

---

## Status Map

| Linear State   | What it means                                              |
|----------------|------------------------------------------------------------|
| Todo           | Ready for an agent to pick up                             |
| In Progress    | Agent is actively implementing                            |
| Human Review   | PR open, awaiting human feedback                          |
| Merging        | Human approved; agent lands the PR                        |
| Rework         | Human sent it back; agent addresses feedback and re-opens |
| Done           | Merged and closed — terminal, no action                   |
| Closed         | Cancelled / terminal — no action                          |

---

## Step 0 — Route by State

Fetch the issue. Read its current Linear state and route:

- **Backlog** → do nothing, exit
- **Todo** → immediately transition to **In Progress**, then continue to Step 1
- **In Progress** → continue to Step 1 (workpad may already exist)
- **Human Review** → continue to Step 2 (PR feedback sweep)
- **Merging** → jump directly to Step 4
- **Rework** → continue to Step 2 (re-open implementation, address all comments)
- **Done / Closed / Cancelled / Canceled / Duplicate** → do nothing, exit

---

## Step 1 — Orient and Plan

1. Read the issue title, description, and all linked comments.
2. Identify acceptance criteria and any provided Validation/Test Plan — these are **mandatory gates**.
3. Identify any linked or blocking issues and read them too.
4. Create (or update) the **Codex Workpad** comment with a concrete, hierarchical task checklist.
5. Determine the branch name: `PAR-{number}/short-description` (lowercase, hyphens, max 60 chars total).
6. Check whether a branch for this issue already exists at `origin/main`:
   - If yes, check it out and `git pull --rebase origin main`.
   - If no, branch from `origin/main`: `git fetch origin main && git checkout -b PAR-{number}/short-description origin/main`.

---

## Step 2 — Implement

Work through the Workpad checklist. For every sub-task:

1. Make the change in the smallest safe increment.
2. Run the quality gate after each logical unit of work:
   ```
   pnpm lint && pnpm test && pnpm build
   ```
3. Fix any lint, type, or test failures before continuing.
4. Commit with a conventional-commit message referencing the issue:
   ```
   git commit -m "feat(PAR-{number}): short description"
   ```
5. Tick the Workpad checklist item and update the Notes section.

### Stack-specific guidance

- **Engine / topology runtime** (`packages/core`): when adding agent classes or extending the topology spec, mirror the existing patterns under `packages/core/src/agents/` and `packages/core/src/topology/`. The OpenSpec change directories under `openspec/changes/` define the contract; cross-reference them.
- **HTTP server** (`packages/server`, Hono): routes live in `packages/server/src/routes.ts`. Add new endpoints next to the existing ones. Validate request bodies with `zod` schemas (existing pattern: `DeliberateBodySchema`).
- **CLI** (`packages/cli`): commander-based; add subcommands alongside existing ones in `packages/cli/src/`.
- **UI** (`packages/ui`, React + Vite): components in `packages/ui/src/components/`, API client in `packages/ui/src/lib/api.ts`. Keep new components functional + hooks-first, no new UI libraries without rationale.
- **Type contract**: `packages/core/src/types.ts` is the engine's source of truth for `Turn`, `DeliberationResult`, etc. Server response shape inherits from these — extend additively (don't rename existing fields without keeping a one-release alias).
- **Tests**: vitest. Co-locate `*.test.ts` next to source. Tickets that mention an integration or component test are non-negotiable gates.

If you need to write temporary code to reproduce or verify a bug, document the technique in the Workpad Notes and revert it before the final commit.

---

## Step 3 — Pre-Handoff Completion Bar

Before transitioning to **Human Review**, confirm every item:

- [ ] All acceptance criteria from the issue are addressed
- [ ] All validation/test requirements from the issue are passing
- [ ] `pnpm lint` exits 0
- [ ] `pnpm test` exits 0
- [ ] `pnpm build` exits 0
- [ ] Branch is up to date: `git pull --rebase origin main`
- [ ] PR is open targeting `main` on `heybeaux/parliament`
- [ ] PR description summarises changes and links the Linear issue
- [ ] The `symphony` label is applied to the PR
- [ ] Workpad comment is updated with PR URL and all tasks ticked

Once all items are checked, transition the issue to **Human Review**.

---

## Step 4 — Merge (Merging state only)

Follow these steps exactly — do not skip or reorder:

1. `git fetch origin main`
2. `git rebase origin/main` — resolve any conflicts; if rebase fails, abort and comment on the PR explaining the conflict.
3. `pnpm lint` — must exit 0.
4. `pnpm test` — must exit 0.
5. `pnpm build` — must exit 0.
6. Merge the PR via `gh pr merge --squash --auto`.
7. Transition the issue to **Done**.
8. Update the Workpad with merge SHA.

---

## Guardrails

- **The only target branch is `main`.** Do not push to other long-lived branches.
- **Never force-push** a branch that already has an open PR.
- If the prior branch PR is already closed or merged, create a **fresh branch from `origin/main`** — do not reuse prior implementation state.
- Do not edit files outside the workspace root (`~/code/par-workspaces/PAR-{number}`).
- Do not commit `.env*` files, secrets, or credentials.
- Do not install new production dependencies without noting the rationale in the Workpad.
- The OpenSpec change spec for a ticket (under `openspec/changes/`) is binding when present; honour the listed Acceptance Criteria and don't expand scope.
- Out-of-scope improvements discovered during execution: file a separate Linear issue in **Backlog**, link it as `related`, and continue with the original ticket.
- If a required tool is unavailable after one fallback attempt, comment on the Linear issue describing the blocker and exit.
- Issues in terminal states (Done, Closed, Cancelled, Canceled, Duplicate) require **no action** — exit immediately.
