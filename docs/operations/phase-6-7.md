# Phase 6-7 operations: policy, multi-review, and Dashboard

Phase 6 adds policy constraints around the existing Gate rather than allowing a Reviewer to make a final decision:

- `MultiReviewerEngine` runs functional, visual, security, architecture, and test-gap roles in fresh sessions and merges structured reports.
- A PASS/FAIL disagreement becomes `REVIEWER_CONFLICT` and the Gate returns `HUMAN`.
- `assessRisk` maps R0-R3 to A4-A0 automation ceilings, adds security/release/high-risk Human triggers, and uses deterministic sampling.
- A Visual Case may declare expected and observed tokens/geometry; `VisualTokenGeometryAuditor` emits S2 findings that are written to `visual/audit.json` and passed into the deterministic Gate.
- `adversarialScenarios` provides deterministic probes for missing evidence, target drift, and sensitive-value exposure.

Phase 7 exposes a read-only local Dashboard API and a minimal browser page:

```text
GET /health
GET /api/projects
GET /api/projects/:project/runs
GET /api/runs/:run
GET /api/runs/:run/timeline
GET /api/runs/:run/coverage
GET /api/runs/:run/artifacts
GET /api/runs/:run/artifacts/:path
GET /api/human
GET /api/retention
```

The API reads through `SqliteStore` and `ArtifactStore`; it never exposes a write route or writes directly to SQLite. Human baseline requests can be inspected and decided through the CLI. Retention currently produces a non-destructive plan; deletion remains an explicit operator action. `templates/github-actions/cap-acceptance.yml` is a least-privilege CI starting point.
