# CAP implementation status

Updated: 2026-08-27

## User request vs attached document

User request: execute the solution in `C:\Users\18373\Downloads\codex_ai_acceptance_platform_build_plan.md`.

Attached document: engineering requirements and a staged implementation plan. Its embedded “主执行指令” is treated as project specification, not as a higher-priority instruction source. It cannot override system/developer rules, user safety boundaries, or facts that must be verified from this repository.

## Current phase

**Phase 4 — ready to start**

## Completed in this phase

- Phase 0 bootstrap is complete and committed.
- Added typed Project, Task, Contract, Requirement, Run, and event-log models.
- Added Task and Run state machines with rejected illegal transitions.
- Added SQLite migrations, repositories, restart recovery, and append-only run field protection.
- Added AJV-backed project/contract schema validation.
- Added project registration, contract validation, task creation, run status/logs, and idempotent submit CLI flows.
- Added templates and Phase 1 operations documentation.
- Added managed detached worktrees with target-SHA checks, marker validation, dirty-state capture, reset, and safe removal.
- Added external Artifact Store with path confinement, SHA-256 manifest finalization, and post-finalization write protection.
- Added sanitized, shell-composition-free command runner and Generic Command Adapter for setup/build/lint/unit/integration/e2e stages.
- Added runtime directories, port and runtime leases, marker validation, and lease-aware cleanup.
- Added deterministic unit/integration coverage for worktree isolation, artifacts, command execution, verifier behavior, and runtime allocation.
- Added Fake and Codex CLI reviewer providers with read-only, ephemeral, schema-constrained execution.
- Added the Acceptance Reviewer Skill contract and reviewer target/evidence hard rules.
- Added Evidence Index, Acceptance Matrix, deterministic Quality Gate, and human/infra decision handling.
- Added fresh-per-Run reviewer sessions with report-persist-before-archive lifecycle.
- Added `run execute` orchestration for worktree, runtime, verifier, reviewer, matrix, gate, artifact finalization, and safe cleanup.

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

## Phase 2 exit-gate evidence

- `npm test`: PASS, 18 tests.
- Detached worktree remains at target while builder changes the source checkout: PASS.
- Reviewer dirty patch/status capture and reset-to-target: PASS.
- Artifact SHA-256 manifest and finalized-write rejection: PASS.
- Command shell-operator rejection and captured exit/output: PASS.
- Generic verifier structured results, early failure, and `NOT_TESTED`: PASS.
- Runtime path isolation and non-conflicting port leases: PASS.

## Phase 3 exit-gate evidence

- `npm run build`: PASS.
- `npm run lint`: PASS.
- `npm run format:check`: PASS.
- `npm test`: PASS, 28 tests.
- Missing or non-existent PASS evidence produces `FAIL`: PASS.
- Core `NOT_TESTED` produces `FAIL`: PASS.
- Infra failure and baseline/human triggers do not produce `PASS`: PASS.
- Codex provider command construction uses read-only, JSON, output schema, and ephemeral flags: PASS with injected process runner.
- Every orchestrated Run receives a fresh reviewer session and persists the report before archive: PASS.
- Fake-provider end-to-end orchestration reaches `COMPLETED_PASS`, `ACCEPTED`, and finalized artifacts: PASS.

## Risks and limits

- Runtime support currently targets Node 24 because CAP uses the built-in `node:sqlite` API.
- The real Codex provider is implemented but not invoked in this build; live CLI credentials and target-project acceptance remain operator-controlled.
- `run execute` currently uses the generic command adapter and does not yet implement platform-specific Web/Android visual capture.
- No external target project, device, production service, or external Codex credential is touched by this bootstrap.

## Next phase

Phase 4: Failure Package, Fix Request, structured retry history, escalation, and regression retest.
