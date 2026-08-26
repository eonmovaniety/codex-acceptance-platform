# Phase 4 operations: failure package and fix loop

An automatic `FAIL` is a durable state transition, not a free-form message:

```text
COMPLETED_FAIL
  -> failure/failure-package.json
  -> failure/fix-request.json
  -> failure/impact-analysis.json
  -> Task FIX_REQUESTED
  -> acceptance fix start <project> <task>
  -> Builder creates a new commit
  -> acceptance submit ...
  -> a new Run and fresh Reviewer
```

The old Run remains immutable and its artifacts remain addressable by project, task, and Run ID. The new Reviewer receives paths to prior structured failure packages but never inherits the previous reviewer session.

## Escalation

The first failure is `AUTO_FIX`; subsequent failures for the same task are raised to `ROOT_CAUSE_REVIEW`, `ARCHITECTURE_REVIEW`, and then `HUMAN_REQUIRED`. This is a deterministic ceiling, not permission to bypass the contract or Gate.

The MVP Impact Analyzer parses changed files from the target diff and always includes core requirements and `core-smoke` in the retest plan. Project-specific dependency graphs and requirement-to-file maps are extension points for later phases.
