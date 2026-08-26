import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { AcceptanceContract, ProjectConfig } from "../../src/domain.js";
import { AcceptanceController } from "../../src/controller.js";
import type { GitClient } from "../../src/git.js";
import { SqliteStore, type Clock } from "../../src/storage.js";

const fixedClock: Clock = { now: () => "2026-08-27T00:00:00.000Z" };

class FakeGit implements GitClient {
  resolveCommit(): string {
    return "0123456789abcdef0123456789abcdef01234567";
  }

  statusPorcelain(): string {
    return "";
  }

  version(): string {
    return "fake-git";
  }
}

test("submit is idempotent and preserves the immutable target", async () => {
  const root = await mkdtemp(join(process.cwd(), ".test-submit-"));
  const acceptance = join(root, ".acceptance");
  await mkdir(acceptance, { recursive: true });
  const configPath = join(acceptance, "project.yaml");
  const contractPath = join(acceptance, "TASK-001.yaml");
  await writeFile(configPath, "version: 1\n", "utf8");
  await writeFile(contractPath, "version: 1\n", "utf8");
  const config: ProjectConfig = {
    version: 1,
    project_id: "sample-submit",
    display_name: "Sample Submit",
    repository: { base_branch: "main", require_clean_submission: true },
    test_data: { version: "v1" },
    gate: { policy_version: "v1" },
  };
  const contract: AcceptanceContract = {
    version: 1,
    contract_id: "TASK-001-v1",
    task_id: "TASK-001",
    title: "Reconnect",
    risk_level: "R1",
    requirements: [
      {
        id: "AC-01",
        title: "Reconnects",
        criticality: "core",
        verification: { modes: ["unit"], required_evidence: "E2" },
      },
    ],
  };
  const store = new SqliteStore(join(root, "cap.sqlite"), fixedClock);
  const controller = new AcceptanceController({
    store,
    git: new FakeGit(),
    clock: fixedClock,
  });
  const project = controller.registerProject(config, configPath);
  const first = controller.submit(
    project,
    config,
    contract,
    contractPath,
    "short-ref",
  );
  const second = controller.submit(
    project,
    config,
    contract,
    contractPath,
    "short-ref",
  );

  assert.equal(first.existing, false);
  assert.equal(second.existing, true);
  assert.equal(first.run.id, second.run.id);
  assert.equal(store.listRuns(project.id, contract.task_id).length, 1);
  assert.equal(
    store.getTask(project.id, contract.task_id).status,
    "IN_ACCEPTANCE",
  );
  assert.deepEqual(
    store.listEvents(first.run.id).map((event) => event.eventType),
    ["TaskSubmitted", "RunCreated"],
  );

  const started = controller.startRun(first.run.id);
  assert.equal(started.status, "VALIDATING");
  assert.equal(
    store.listEvents(first.run.id).at(-1)?.eventType,
    "TargetValidated",
  );
  store.close();
  await rm(root, { recursive: true, force: true });
});
