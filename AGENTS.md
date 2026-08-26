# CAP project rules

This repository implements the Codex AI Acceptance Platform build plan.

## Non-negotiable rules

- An acceptance run is bound to an immutable target commit, contract version, test-data version, and gate-policy version.
- Builder and reviewer claims are evidence inputs; only the deterministic gate can produce the final `PASS`, `FAIL`, or `HUMAN` decision.
- No evidence, `NOT_TESTED`, or an unreadable artifact can produce `PASS`.
- Every run uses a fresh reviewer context. Builder conversation and private reasoning are not reviewer inputs.
- Reviewer changes are captured as proposed patches and never change the verdict for the original target commit.
- Completed runs are append-only. A re-test creates a new run.
- Baseline, contract, architecture, release, irreversible, and high-risk changes require a human gate.
- Runtime, worktree, and artifact cleanup may only touch paths owned and marked by CAP.
- Secrets and private data must be redacted before persistence.

## Engineering rules

- Keep control-plane code separate from execution-plane code.
- Use dependency injection for Git, filesystem, command execution, clock, and reviewer providers.
- Validate every cross-boundary JSON document against a versioned schema.
- Keep tests deterministic and make fake providers the CI default.
- Preserve dirty work and unrelated changes; never reset or delete a user path without explicit scope.
