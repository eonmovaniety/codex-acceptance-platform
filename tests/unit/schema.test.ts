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

test("project schema accepts Forgejo polling configuration", () => {
  const project = validateDocument<ProjectConfig>("project", {
    version: 1,
    project_id: "forgejo-project",
    display_name: "Forgejo project",
    repository: { base_branch: "master" },
    automation: {
      enabled: true,
      tasks: [{ task_id: "TASK-001", contract: ".acceptance/contract.yaml" }],
      ci: {
        provider: "forgejo-poll",
        server_url: "http://192.168.31.9:3000",
        owner: "Silmaril",
        repo: "atmosphere-engine",
        credential_ref: "cap-secret://forgejo/Silmaril",
        status_context: "cap/atmosphere-acceptance",
        poll_seconds: 5,
      },
    },
  });
  assert.equal(project.automation?.ci?.provider, "forgejo-poll");
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
