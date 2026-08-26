# Troubleshooting

- If `doctor` reports an old Node version, use Node 24 or newer because the first CAP runtime uses `node:sqlite`.
- If a Run is `INFRA_FAILED`, inspect `run/error.json`, event logs, runtime markers, and worktree markers before retrying.
- If a Gate is `FAIL`, inspect `acceptance/gate-decision.json`, `acceptance/matrix.json`, and `failure/failure-package.json`; start a fix cycle before submitting another commit.
- If a Gate is `HUMAN`, use the Human request and visual summary. Do not replace a baseline or contract manually.
- If artifacts are finalized, create a new Run. Finalization is intentionally write-protected.
- If a managed resource remains, use the marker-aware cleanup path; do not delete broad workspace paths manually.
