# ADR-002: Acceptance runs are immutable

## Decision

Once a run is created, its target commit, contract version, test-data version, and gate-policy version cannot be edited. Re-tests create new runs.

## Consequences

Reports remain auditable and a later builder commit cannot silently change an earlier acceptance result.
