# Commit-triggered automation

CAP automation is opt-in and has two independent execution scopes:

| Source            | Scope   | Meaning                                              |
| ----------------- | ------- | ---------------------------------------------------- |
| `post_commit`     | `local` | Fast advisory feedback from the Windows login Worker |
| `ci_pull_request` | `ci`    | Authoritative PR Gate                                |
| `ci_push`         | `ci`    | Authoritative regression on `master`                 |

The exact commit SHA, contract content, test-data version, Gate policy version,
and execution scope form the Run idempotency identity. A repeated event reuses
its existing Job; a local Run never overwrites the CI result or `accepted_commit`.

## Local installation

```powershell
npm install
npm run build
npm run acceptance -- init --home C:\Users\<user>\.codex-acceptance
npm run acceptance -- project add C:\path\to\project --home C:\Users\<user>\.codex-acceptance
npm run acceptance -- automation install --project <project-id> --task <task-id> --home C:\Users\<user>\.codex-acceptance
```

`automation install` manages `.git/hooks/post-commit`, preserves an existing
hook in `.git/cap-automation/original-post-commit`, and registers the current
user's `CAP Acceptance Worker` login task on Windows. `automation uninstall`
restores the previous hook and removes the managed task. The task is configured
to restart the Worker up to three times with a one-minute interval after a
crash. The generated hook does not wait for verification and never invalidates
the Git commit.

The Worker serves the local read-only Dashboard on port `4173` and can be
checked with:

```powershell
npm run acceptance -- automation status --project <project-id> --watch --home C:\Users\<user>\.codex-acceptance
```

The status view exposes Job state (`QUEUED`, `RUNNING`, `RETRY_WAIT`,
`SUCCEEDED`, `BLOCKED`, or `DEAD_LETTER`) and Outbox/Delivery state. A
notification failure is recorded and retried; it cannot change the Gate.

## CI pinning

Copy `templates/github-actions/cap-acceptance.yml` into the target repository
and set repository variables:

- `CAP_REPOSITORY`: independent CAP repository in `owner/repository` form;
- `CAP_REF`: full 40-character CAP commit SHA;
- `CAP_SHA256`: optional SHA-256 of `git archive --format=tar HEAD` at `CAP_REF`;
- `CAP_PROJECT_ID` and `CAP_TASK_ID`: target project/task identifiers.

The checked-in AtmosphereEngine Workflow is already specialized to
`atmosphere-engine` and its CAP task. PRs use the exact
`pull_request.head.sha`; `master` pushes use `github.sha`. Target and CAP
checkouts use `fetch-depth: 0` and do not persist credentials. The CI Job
uploads the complete CAP Home as an artifact and exits non-zero for every
Gate other than `PASS`.

The CAP repository currently has no remote configured in this workspace. CI
therefore remains intentionally blocked until an independent remote CAP
repository is created and `CAP_REPOSITORY`/`CAP_REF` are set to a readable,
immutable commit.

## Result interpretation

The concise result is in `acceptance/summary.json` and `summary.md`:

```text
Run ID exists
Status = COMPLETED_PASS
Gate = PASS
core_pass = core_total
evidence_refs are present and downloadable
```

`COMPLETED_FAIL`, `COMPLETED_HUMAN`, `INFRA_FAILED`, `BLOCKED`, and
`NOT_TESTED` are not merge approval. Infrastructure failures can create one
new immutable Attempt Run (`retry_of` points at the previous Run); functional
failures are never retried automatically.

## Disable and rollback

To stop new local enqueue operations, set `automation.enabled: false` in the
project configuration. To remove host integration, run:

```powershell
npm run acceptance -- automation uninstall --project <project-id> --home C:\Users\<user>\.codex-acceptance
```

Historical Runs, artifacts, and notification audit records are retained.
