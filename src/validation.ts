import { Ajv } from "ajv";
import type { ErrorObject } from "ajv";
import { SchemaValidationError } from "./errors.js";
import { capSchemas, type SchemaName } from "./schemas.js";

const ajv = new Ajv({ allErrors: true, strict: false });
const validators = new Map<SchemaName, ReturnType<typeof ajv.compile>>();

export function validateDocument<T>(schemaName: SchemaName, value: unknown): T {
  let validator = validators.get(schemaName);
  if (!validator) {
    validator = ajv.compile(capSchemas[schemaName]);
    validators.set(schemaName, validator);
  }
  if (!validator(value)) {
    throw new SchemaValidationError(schemaName, validator.errors ?? []);
  }
  return value as T;
}

export function schemaErrors(error: unknown): ErrorObject[] {
  if (error instanceof SchemaValidationError && Array.isArray(error.details)) {
    return error.details as ErrorObject[];
  }
  return [];
}
