export class CapError extends Error {
  constructor(
    message: string,
    public readonly code = "CAP_ERROR",
  ) {
    super(message);
    this.name = "CapError";
  }
}

export class StateTransitionError extends CapError {
  constructor(
    public readonly entity: "task" | "run",
    public readonly from: string,
    public readonly to: string,
  ) {
    super(
      `Invalid ${entity} state transition: ${from} -> ${to}`,
      "INVALID_STATE_TRANSITION",
    );
    this.name = "StateTransitionError";
  }
}

export class NotFoundError extends CapError {
  constructor(entity: string, id: string) {
    super(`${entity} '${id}' was not found`, "NOT_FOUND");
    this.name = "NotFoundError";
  }
}

export class SchemaValidationError extends CapError {
  constructor(
    public readonly schemaName: string,
    public readonly details: unknown,
  ) {
    super(`Schema validation failed: ${schemaName}`, "SCHEMA_INVALID");
    this.name = "SchemaValidationError";
  }
}

export class ImmutableRunError extends CapError {
  constructor(message: string) {
    super(message, "IMMUTABLE_RUN");
    this.name = "ImmutableRunError";
  }
}
