# Phase 2 operations

Phase 2 keeps target-project source and CAP evidence separate:

```text
target repo -> managed detached worktree -> sanitized command runner
                                             -> external Artifact Store
```

The worktree marker and runtime marker are CAP-owned records. Cleanup must validate those markers and the managed root before removing anything. A reviewer patch is evidence about a proposed change; it never changes the target commit recorded by the Run.

Generic commands are tokenized without a shell. Shell composition (`|`, `;`, `&`, redirection, backticks, and newlines) is rejected. Commands run with a small environment allowlist, and Codex/cloud credential variables are removed before execution.
