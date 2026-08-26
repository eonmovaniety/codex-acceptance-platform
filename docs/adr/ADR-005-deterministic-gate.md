# ADR-005: Deterministic quality gate

## Decision

The reviewer may provide structured recommendations, but a pure rule engine computes `PASS`, `FAIL`, or `HUMAN`.

## Consequences

Free-form reviewer text cannot bypass missing evidence, critical failures, or human-triggered changes.
