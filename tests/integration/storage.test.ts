import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { AcceptanceRun, Project, Task } from "../../src/domain.js";
import { ImmutableRunError } from "../../src/errors.js";
import { SqliteStore, type Clock } from "../../src/storage.js";

const fixedClock: Clock = { now: () => "2026-08-27T00:00:00.000Z" };

test("SQLite state and event log survive a restart", async () => {
  const root = await mkdtemp(join(process.cwd(), ".test-storage-"));
  const dbPath = join(root, "state", "acceptance.sqlite");
  const project: Project = {
    id: "sample",
    name: "Sample",
    repoPath: root,
    baseBranch: "main",
    configPath: join(root, ".acceptance", "project.yaml"),
    status: "ACTIVE",
    createdAt: fixedClock.now(),
    updatedAt: fixedClock.now(),
  };
  const task: Task = {
    id: "TASK-001",
    projectId: project.id,
    title: "Reconnect",
    status: "IN_ACCEPTANCE",
    riskLevel: "R1",
    failureCount: 0,
    createdAt: fixedClock.now(),
    updatedAt: fixedClock.now(),
  };
  const run: AcceptanceRun = {
    id: "RUN-001",
    projectId: project.id,
    taskId: task.id,
    targetCommit: "0123456789abcdef0123456789abcdef01234567",
    contractVersion: "1",
    testDataVersion: "v1",
    gatePolicyVersion: "v1",
    idempotencyKey: "key-1",
    status: "CREATED",
    createdAt: fixedClock.now(),
  };

  const first = new SqliteStore(dbPath, fixedClock);
  first.createProject(project);
  first.createTask(task);
  first.createRun(run);
  first.appendEvent(run.id, "RunCreated", { source: "test" });
  assert.equal(first.getRun(run.id).targetCommit, run.targetCommit);
  first.close();

  const second = new SqliteStore(dbPath, fixedClock);
  assert.equal(second.getTask(project.id, task.id).status, "IN_ACCEPTANCE");
  assert.deepEqual(
    second.listEvents(run.id).map((event) => event.eventType),
    ["RunCreated"],
  );
  assert.equal(second.findRunByIdempotencyKey("key-1")?.id, run.id);
  assert.throws(
    () =>
      second.updateRun({
        ...run,
        targetCommit: "fedcba9876543210fedcba9876543210fedcba98",
      }),
    ImmutableRunError,
  );
  second.close();
  await rm(root, { recursive: true, force: true });
});
