# ADR-001: Layered architecture

## Decision

Use a control-plane domain/core layer and an execution-plane adapter layer. Cross-boundary data is represented by versioned schemas.

## Consequences

State transitions and gate decisions remain testable without starting a target application. Platform adapters can be replaced without changing the acceptance contract.
