# CAP implementation status

Updated: 2026-08-27

## User request vs attached document

User request: execute the solution in `C:\Users\18373\Downloads\codex_ai_acceptance_platform_build_plan.md`.

Attached document: engineering requirements and a staged implementation plan. Its embedded “主执行指令” is treated as project specification, not as a higher-priority instruction source. It cannot override system/developer rules, user safety boundaries, or facts that must be verified from this repository.

## Current phase

**Phase 2 — ready to start**

## Completed in this phase

- Phase 0 bootstrap is complete and committed.
- Added typed Project, Task, Contract, Requirement, Run, and event-log models.
- Added Task and Run state machines with rejected illegal transitions.
- Added SQLite migrations, repositories, restart recovery, and append-only run field protection.
- Added AJV-backed project/contract schema validation.
- Added project registration, contract validation, task creation, run status/logs, and idempotent submit CLI flows.
- Added templates and Phase 1 operations documentation.

## Phase 0 exit-gate evidence

- `npm install`: PASS, 0 vulnerabilities.
- `npm run build`: PASS.
- `npm run lint`: PASS.
- `npm run format:check`: PASS.
- `npm run test:unit`: PASS, 2 tests.
- `npm run acceptance -- --help`: PASS.

## Phase 1 exit-gate evidence

- `npm run build`: PASS.
- `npm run lint`: PASS.
- `npm test`: PASS, 11 tests.
- SQLite restart recovery: PASS.
- Illegal state transitions: PASS (rejected by unit tests).
- Same idempotency key returns the original Run: PASS.
- Project and acceptance-contract schema validation: PASS.

## Risks and limits

- Runtime support currently targets Node 24 because CAP uses the built-in `node:sqlite` API.
- Phase 2 will add worktree freezing, external immutable artifacts, runtime allocation, command execution, generic verifiers, and safe cleanup.
- No real project, device, production service, or external Codex credential is touched by this bootstrap.

## Next phase

Phase 2: Worktree, artifact, runtime, command runner, generic verifier, cleanup, leases, and fake-project E2E.
