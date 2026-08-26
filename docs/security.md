# Security boundaries

- Build/test commands run without shell composition and with a sanitized environment.
- Reviewer execution is read-only and receives contract, target, verifier, and evidence facts—not Builder conversation or private reasoning.
- CAP-owned worktrees, runtime directories, baseline cache, and artifact paths are marker-checked and confined.
- Secrets are removed from the generic command environment and are not persisted in reports or logs.
- Baseline, release, security-sensitive, high-risk, contract, and reviewer-conflict decisions create Human triggers.
- The Dashboard API binds to loopback by default and exposes read-only projections.

This repository does not claim production, device, or credential acceptance. A real project adapter must add its own secret, network, and destructive-operation policy before use.
