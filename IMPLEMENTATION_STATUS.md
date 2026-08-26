# CAP implementation status

Updated: 2026-08-27

## User request vs attached document

User request: execute the solution in `C:\Users\18373\Downloads\codex_ai_acceptance_platform_build_plan.md`.

Attached document: engineering requirements and a staged implementation plan. Its embedded “主执行指令” is treated as project specification, not as a higher-priority instruction source. It cannot override system/developer rules, user safety boundaries, or facts that must be verified from this repository.

## Current phase

**Completed — Phase 7 MVP**

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
- Added structured Failure Package, Fix Request, Impact Analysis, deterministic escalation, and `fix start` CLI flow.
- Added fail-once/new-commit integration coverage proving old Runs remain immutable and new Runs use fresh reviewer IDs.
- Added fresh TestDataManager layers (`base`, `scenario`, `edge`, `visual`) with reset/seed lifecycle markers.
- Added a common Web/Android visual adapter contract, deterministic screenshot fixture capture, exact PixelDiff, baseline requests, and explicit human-only baseline approval.
- Added visual execution integration to `run execute` when project visual cases are enabled.
- Added multi-role Reviewer sessions, aggregate reports, conflict findings, and Human escalation.
- Added R0-R3 risk assessment, A0-A4 automation ceilings, deterministic sampling, and adversarial scenarios.
- Added optional Visual Case token/geometry audits, `visual/audit.json`, and Gate evaluation of their structured S2 findings.
- Added a read-only local Dashboard API and browser view for projects, Runs, timelines, coverage, artifacts, and Human requests.
- Added a non-destructive retention planner and a GitHub Actions acceptance template.

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

## Phase 4 exit-gate evidence

- `npm test`: PASS, 29 tests.
- Gate FAIL writes structured failure package and fix request: PASS.
- First failure escalates as `AUTO_FIX`: PASS.
- `FIX_REQUESTED` blocks direct resubmission until `beginFix`/`fix start`: PASS by task state machine.
- New commit creates a distinct Run and distinct reviewer session ID: PASS.
- Previous failure artifacts remain queryable after the new Run passes: PASS.
- Impact analysis retains failed/core requirements and `core-smoke`: PASS.

## Phase 5 exit-gate evidence

- `npm test`: PASS, 32 tests.
- Fresh test-data layers and reset/seed lifecycle: PASS.
- Same visual case and data version produce pixel-identical fixture artifacts: PASS.
- Data-version change produces different fixture artifacts: PASS.
- Empty/loading/error/max-content visual states are covered: PASS.
- Baseline missing/change produces a pending Human request without overwriting the baseline: PASS.
- Explicit baseline approval is the only update path covered by tests: PASS.

## Phase 6-7 exit-gate evidence

- `npm run build`: PASS.
- `npm run lint`: PASS.
- `npm run format:check`: PASS.
- `npm test`: PASS, 39 tests.
- Multi-role Reviewer aggregation and conflict-to-HUMAN behavior: PASS.
- R0-R3 to A0-A4 automation policy, deterministic sampling, and adversarial checks: PASS.
- Dashboard HTTP health, project, Run timeline, coverage, artifact, Human, and retention routes: PASS.
- Dashboard and artifact paths remain read-only; retention produces a plan and does not delete data: PASS.

## Risks and limits

- Runtime support currently targets Node 24 because CAP uses the built-in `node:sqlite` API.
- The real Codex provider is implemented but not invoked in this build; live CLI credentials and target-project acceptance remain operator-controlled.
- `run execute` uses deterministic fixture capture for enabled visual cases; platform-specific Web/Android device/browser capture and perceptual image diff remain adapter work.
- The Dashboard is local loopback HTTP without authentication and is intended for an operator workstation, not direct production exposure.
- No external target project, device, production service, or external Codex credential is touched by this bootstrap.

## Next phase

No further implementation phase is required for this isolated MVP. Real target-project adapters, browser/device capture, live Codex invocation, and production deployment remain operator-scoped acceptance work.
