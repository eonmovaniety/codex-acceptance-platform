import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { ProjectConfig } from "../../src/domain.js";
import { resolveAcceptanceHome } from "../../src/paths.js";
import { TestDataManager } from "../../src/test-data.js";
import type { CommandResult, CommandRunner } from "../../src/runner.js";

class RecordingRunner implements CommandRunner {
  readonly commands: string[] = [];

  run(command: string): CommandResult {
    this.commands.push(command);
    return {
      command,
      executable: "fixture",
      args: [],
      exitCode: 0,
      stdout: "ok\n",
      stderr: "",
      durationMs: 1,
      timedOut: false,
    };
  }
}

test("test data manager creates fresh base/scenario/edge/visual layers", async () => {
  const root = await mkdtemp(join(process.cwd(), ".test-data-"));
  const runtimePath = join(
    resolveAcceptanceHome(join(root, "home")).runtime,
    "RUN-001",
  );
  const runner = new RecordingRunner();
  const config: ProjectConfig = {
    version: 1,
    project_id: "project",
    display_name: "Project",
    repository: { base_branch: "main" },
    test_data: {
      version: "fixture-v2",
      reset_command: "fixture reset",
      seed_command: "fixture seed",
    },
  };
  const manager = new TestDataManager();
  const manifest = manager.prepare({
    runId: "RUN-001",
    runtimePath,
    config,
    runner,
  });
  assert.equal(manifest.fresh_database, true);
  assert.deepEqual(runner.commands, ["fixture reset", "fixture seed"]);
  for (const layer of ["base", "scenario", "edge", "visual"])
    assert.equal(existsSync(join(manifest.root, layer)), true);
  manager.destroy(manifest);
  assert.equal(existsSync(manifest.root), false);
  await rm(root, { recursive: true, force: true });
});
