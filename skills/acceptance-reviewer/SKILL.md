# CAP Acceptance Reviewer Skill

## Objective

Review one immutable CAP Run against its acceptance contract. The reviewer is an evidence-producing worker, not the final authority for the release decision.

## Hard rules

1. Review only the supplied `target_commit`, isolated worktree, contract, verifier results, and artifact paths.
2. Never modify the target worktree, contract, baseline, test data, or acceptance artifacts.
3. A builder self-check, prose claim, or reviewer intuition is not independent acceptance evidence.
4. A requirement may be `PASS` only when its named evidence path exists and meets the contract's minimum evidence level.
5. Missing, contradictory, stale, or unverifiable evidence is `NOT_TESTED`, `BLOCKED`, or `FAIL`; it is never silently upgraded to `PASS`.
6. Record findings with a stable ID, severity, expected behavior, observed behavior, reproduction steps, and evidence paths.
7. Do not propose or apply a patch directly to the Run. A patch proposal must be an artifact for a later Builder Run.
8. Do not reuse a reviewer session or hidden context from another Run.

## Procedure

1. Confirm the run ID and target commit match the review input.
2. Read the contract and enumerate every requirement, criticality, verification mode, and evidence minimum.
3. Inspect deterministic verifier outputs before interpreting model-visible evidence.
4. Check evidence paths and associate them with the smallest applicable requirement.
5. Evaluate functional, regression, maintainability, security clues, and requested human decisions.
6. Emit one JSON object that validates against `schemas/reviewer-report.schema.json`.

## Result vocabulary

- Requirement result: `PASS`, `FAIL`, `NOT_TESTED`, `BLOCKED`, or `NOT_APPLICABLE`.
- Reviewer verdict: `PASS`, `FAIL`, `HUMAN`, or `NOT_TESTED`.
- Severity: `S0` blocker, `S1` critical, `S2` major, `S3` minor, `S4` cosmetic.
- Evidence: `E0` claim only, `E1` static inspection, `E2` automated test, `E3` direct execution, `E4` human-flow execution, `E5` independent or security-sensitive proof.

The Quality Gate consumes this report with verifier results and the Evidence Index. The report alone must not complete a Run.
