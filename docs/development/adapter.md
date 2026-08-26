# Adapter development

Project adapters should implement the execution boundary through injected interfaces:

```text
detect -> prepare -> build/lint/unit/integration/e2e -> captureVisuals -> cleanup
```

Adapters must operate on the supplied detached worktree and runtime, report structured results, preserve target SHA integrity, and write only to the Run artifact root. They must not mutate Task or Run state directly. Use `GenericCommandAdapter` for projects whose acceptance commands can be represented as shell-free argv-like strings; add a platform adapter only when it needs browser, Android, container, or VM capabilities.
