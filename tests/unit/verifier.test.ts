import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { ArtifactStore } from "../../src/artifacts.js";
import type { ProjectConfig } from "../../src/domain.js";
import { resolveAcceptanceHome } from "../../src/paths.js";
import { LocalCommandRunner } from "../../src/runner.js";
import {
  GenericCommandAdapter,
  aggregateVerifierResults,
  type VerifierContext,
} from "../../src/verifier.js";

test("generic verifier records deterministic command evidence", async () => {
  const root = await mkdtemp(join(process.cwd(), ".test-verifier-"));
  const context: VerifierContext = {
    runId: "RUN-001",
    projectId: "project",
    taskId: "TASK-001",
    targetCommit: "0123456789abcdef0123456789abcdef01234567",
    worktreePath: root,
    config: {
      version: 1,
      project_id: "project",
      display_name: "Project",
      repository: { base_branch: "main" },
      commands: {
        build: ["node -e \"process.stdout.write('build')\""],
        unit: ['node -e "process.exit(0)"'],
      },
      runtime: { timeout_seconds: 20 },
    } satisfies ProjectConfig,
    artifacts: new ArtifactStore(
      resolveAcceptanceHome(join(root, "cap-home")),
      () => "2026-08-27T00:00:00.000Z",
    ),
    runner: new LocalCommandRunner(),
    assertTarget: () => undefined,
    now: () => "2026-08-27T00:00:00.000Z",
  };
  const results = new GenericCommandAdapter({ stages: ["build", "unit"] }).run(
    context,
  );
  assert.deepEqual(
    results.map((result) => result.result),
    ["PASS", "PASS"],
  );
  assert.equal(aggregateVerifierResults(results), "PASS");
  assert.equal(
    context.artifacts.readText(
      "project",
      "TASK-001",
      "RUN-001",
      "verifier/build/01.stdout.log",
    ),
    "build",
  );
  assert.match(
    context.artifacts.readText(
      "project",
      "TASK-001",
      "RUN-001",
      "verifier/summary.json",
    ),
    /RUN-001/,
  );
  await rm(root, { recursive: true, force: true });
});

test("generic verifier stops after a failed command and marks later stages not tested", async () => {
  const root = await mkdtemp(join(process.cwd(), ".test-verifier-fail-"));
  const artifacts = new ArtifactStore(
    resolveAcceptanceHome(join(root, "cap-home")),
  );
  const context: VerifierContext = {
    runId: "RUN-FAIL",
    projectId: "project",
    taskId: "TASK-001",
    targetCommit: "0123456789abcdef0123456789abcdef01234567",
    worktreePath: root,
    config: {
      version: 1,
      project_id: "project",
      display_name: "Project",
      repository: { base_branch: "main" },
      commands: {
        build: ['node -e "process.exit(3)"'],
        unit: ['node -e "process.exit(0)"'],
      },
    },
    artifacts,
    runner: new LocalCommandRunner(),
    assertTarget: () => undefined,
  };
  const results = new GenericCommandAdapter({ stages: ["build", "unit"] }).run(
    context,
  );
  assert.deepEqual(
    results.map((result) => result.result),
    ["FAIL", "NOT_TESTED"],
  );
  assert.equal(aggregateVerifierResults(results), "FAIL");
  await rm(root, { recursive: true, force: true });
});
