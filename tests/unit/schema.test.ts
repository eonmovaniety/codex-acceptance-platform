import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectConfig } from "../../src/domain.js";
import { SchemaValidationError } from "../../src/errors.js";
import { validateDocument } from "../../src/validation.js";

test("project schema accepts a minimal valid configuration", () => {
  const project = validateDocument<ProjectConfig>("project", {
    version: 1,
    project_id: "sample-project",
    display_name: "Sample Project",
    repository: { base_branch: "main" },
  });
  assert.equal(project.project_id, "sample-project");
});

test("project schema rejects missing repository branch", () => {
  assert.throws(
    () =>
      validateDocument("project", {
        version: 1,
        project_id: "sample-project",
        display_name: "Sample Project",
        repository: {},
      }),
    (error: unknown) =>
      error instanceof SchemaValidationError && error.schemaName === "project",
  );
});

test("contract schema requires evidence and verification modes", () => {
  assert.throws(
    () =>
      validateDocument("acceptance-contract", {
        version: 1,
        contract_id: "TASK-001-v1",
        task_id: "TASK-001",
        title: "Sample",
        requirements: [{ id: "AC-01", title: "Works", criticality: "core" }],
      }),
    SchemaValidationError,
  );
});
