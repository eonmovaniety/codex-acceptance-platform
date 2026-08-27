# Codex Acceptance Platform

CAP is a local-first, CLI-first acceptance platform. It freezes a submitted Git commit, executes deterministic verification in isolated resources, records evidence, asks an independent reviewer for structured findings, and lets code—not free text—evaluate the final quality gate.

## Status

Implementation follows the accompanying build plan one phase at a time. See [`IMPLEMENTATION_STATUS.md`](IMPLEMENTATION_STATUS.md) for the current phase and evidence.

## Quick start

```powershell
npm install
npm run build
npm run lint
npm test
npm run acceptance -- --help
```

After submitting a contract-bound commit, execute its isolated acceptance Run with `npm run acceptance -- run execute <run-id> --json`. A failed Run writes a Failure Package; move the task to `FIXING` with `npm run acceptance -- fix start <project-id> <task-id>` before submitting a new commit.

## Commit-triggered automation

Projects can opt in with `automation.enabled: true`. After CAP is built and
the project is registered, install the local hook and login worker once:

```powershell
npm run acceptance -- automation install --project <project-id> --task <task-id> --home <cap-home>
```

The hook only enqueues the exact commit and returns immediately. A single
login-resident Worker executes the isolated Run and exposes the read-only
Dashboard at `http://127.0.0.1:4173`. Use
`npm run acceptance -- automation status --project <project-id> --watch` for
queue and notification delivery state.

Local `post_commit` Runs are advisory. CI `ci_pull_request` and `ci_push` Runs
are independent and authoritative; only a CI Run with `COMPLETED_PASS` and
`Gate = PASS` is a merge approval. Each Run publishes
`acceptance/summary.json` and `acceptance/summary.md` alongside the matrix,
Gate, and verifier evidence. See
[`docs/operations/automation.md`](docs/operations/automation.md) for the
Workflow pin and rollback procedure.

The first release uses Node's built-in `node:sqlite` runtime available in Node 24, so the state database does not need a native third-party SQLite binding.

## Boundaries

- `src/` contains the current application implementation.
- `packages/` and `apps/` reserve the monorepo package boundaries described by the plan.
- `schemas/` contains versioned cross-boundary contracts.
- `db/migrations/` contains append-only database migrations.
- `skills/acceptance-reviewer/` contains the independent reviewer instructions.
