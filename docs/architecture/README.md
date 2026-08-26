# Architecture

CAP is split into a control plane and an execution plane.

```text
Specification -> Controller -> Orchestrator -> Worktree/Runtime
                                      -> Verifiers/Reviewers
                                      -> Evidence/Matrix -> Deterministic Gate
```

The current implementation starts as a single TypeScript process with explicit module boundaries. It can later be split into the monorepo package directories without changing the domain contracts.
