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

The first release uses Node's built-in `node:sqlite` runtime available in Node 24, so the state database does not need a native third-party SQLite binding.

## Boundaries

- `src/` contains the current application implementation.
- `packages/` and `apps/` reserve the monorepo package boundaries described by the plan.
- `schemas/` contains versioned cross-boundary contracts.
- `db/migrations/` contains append-only database migrations.
- `skills/acceptance-reviewer/` contains the independent reviewer instructions.
