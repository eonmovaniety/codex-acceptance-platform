# Phase 3 operations: reviewer, evidence, matrix, and gate

Phase 3 turns an immutable Run into a structured review decision without allowing the reviewer to be the final authority.

## Provider selection

Use `FakeReviewerProvider` for deterministic local tests. `CodexCliReviewerProvider` is the real adapter. It invokes a fresh non-interactive `codex exec` process with read-only sandboxing, JSONL output, an output schema, and ephemeral session storage. The command is isolated behind `CodexProcessRunner`, so unit tests never require a live Codex credential.

The adapter follows the current official Codex CLI contract: the prompt is one command argument; `--json` emits machine-readable JSONL; `--output-schema` constrains the final result; `--sandbox read-only` prevents agent edits; and `--ephemeral` avoids persisting rollout files. See [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode) and the [Codex CLI command reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli).

## Review lifecycle

1. Create a fresh CAP reviewer session for the Run.
2. Review only the fixed target worktree and supplied artifacts.
3. Validate the returned `reviewer-report` schema and target identity.
4. Persist `reviewer/report.json` before archiving or retaining the session.
5. Build and persist `evidence/index.json` and `acceptance/matrix.json`.
6. Evaluate the matrix using the deterministic Gate Engine and persist `acceptance/gate-decision.json`.

An invalid report, missing core evidence, verifier infrastructure failure, or human trigger cannot produce an automatic `PASS`. Critical findings and human requests are retained for audit.
