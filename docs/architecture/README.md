# Architecture

CAP is split into a control plane and an execution plane.

```text
Specification -> Controller -> Orchestrator -> Worktree/Runtime
                                      -> Verifiers/Reviewers
                                      -> Evidence/Matrix -> Deterministic Gate
                                      -> Failure Package -> new commit/new Run
Dashboard API <- read-only Store/Artifact projections
```

The current implementation starts as a single TypeScript process with explicit module boundaries. It can later be split into the monorepo package directories without changing the domain contracts.

The control plane owns project/task/run state, contracts, policies, Gate decisions, and Human requests. The execution plane owns detached worktrees, leased runtime paths, fresh test data, command execution, visual fixture capture, and externalized artifacts. Reviewer providers and project adapters are injected at the boundary; the Dashboard never writes directly to SQLite or target-project files.
