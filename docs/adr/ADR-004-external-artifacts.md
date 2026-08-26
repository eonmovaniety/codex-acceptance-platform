# ADR-004: Artifacts live outside target repositories

## Decision

Run artifacts are stored in a managed CAP home, not in a target project's working tree.

## Consequences

Reviewers cannot modify evidence by changing project files, and retention can be managed independently of source history.
