import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { ArtifactStore } from "../../src/artifacts.js";
import { AtmosphereEngineAdapter } from "../../src/adapters/atmosphere-engine.js";
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

test("Atmosphere Engine adapter validates the structured runtime bridge report", async () => {
  const root = await mkdtemp(join(process.cwd(), ".test-atmosphere-adapter-"));
  const artifacts = new ArtifactStore(
    resolveAcceptanceHome(join(root, "cap-home")),
  );
  const bridgeCommand = "node .acceptance/probe.mjs --json";
  const targetCommit = "0123456789abcdef0123456789abcdef01234567";
  const context: VerifierContext = {
    runId: "RUN-ATM",
    projectId: "project",
    taskId: "TASK-ATM",
    targetCommit,
    worktreePath: root,
    config: {
      version: 1,
      project_id: "project",
      display_name: "Atmosphere Engine",
      repository: { base_branch: "master" },
      adapter: {
        type: "atmosphere-engine",
        config: { bridge_command: bridgeCommand },
      },
      commands: {
        build: ["node build.mjs"],
        unit: ["node unit.mjs"],
        integration: [bridgeCommand],
      },
    },
    artifacts,
    runner: {
      run: (command) => ({
        command,
        executable: "node",
        args: [],
        exitCode: 0,
        stdout:
          command === bridgeCommand
            ? JSON.stringify({
                version: 1,
                adapter: "atmosphere-engine",
                target_commit: targetCommit,
                engine: {
                  name: "@qiyu/atmosphere-engine",
                  version: "3.0.0",
                  contract_version: "1.0.0",
                },
                target: {
                  target_id: "cap-root",
                  platform: "web",
                  product: "finance",
                },
                result: "PASS",
                checks: [{ id: "runtime", result: "PASS" }],
                runtime: {
                  apply_status: "applied",
                  applied_revision: 1,
                  same_plan_status: "noop",
                  stale_revision_status: "superseded",
                  rollback_status: "rejected",
                  rollback_event_observed: true,
                  preview_isolated: true,
                  event_types: ["AtmosphereApplied"],
                },
                limitations: [],
              })
            : "",
        stderr: "",
        durationMs: 1,
        timedOut: false,
      }),
    },
    assertTarget: () => undefined,
  };
  const results = new AtmosphereEngineAdapter().run(context);
  const bridge = results.find((result) => result.command === bridgeCommand);
  assert.equal(bridge?.result, "PASS");
  assert.ok(
    bridge?.evidence.some((evidence) => evidence.path === "engine/report.json"),
  );
  assert.match(
    artifacts.readText("project", "TASK-ATM", "RUN-ATM", "engine/report.json"),
    /@qiyu\/atmosphere-engine/,
  );
  await rm(root, { recursive: true, force: true });
});
