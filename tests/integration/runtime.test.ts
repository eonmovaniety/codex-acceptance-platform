import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { AcceptanceRun, Project, Task } from "../../src/domain.js";
import { resolveAcceptanceHome } from "../../src/paths.js";
import { RuntimeManager } from "../../src/runtime.js";
import { SqliteStore, type Clock } from "../../src/storage.js";

const fixedClock: Clock = { now: () => "2026-08-27T00:00:00.000Z" };

test("runtime manager allocates isolated paths and non-conflicting leases", async () => {
  const root = await mkdtemp(join(process.cwd(), ".test-runtime-"));
  const store = new SqliteStore(
    join(root, "state", "acceptance.sqlite"),
    fixedClock,
  );
  const project: Project = {
    id: "project",
    name: "Project",
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
    title: "Task",
    status: "IN_ACCEPTANCE",
    riskLevel: "R1",
    failureCount: 0,
    createdAt: fixedClock.now(),
    updatedAt: fixedClock.now(),
  };
  const makeRun = (id: string, key: string): AcceptanceRun => ({
    id,
    projectId: project.id,
    taskId: task.id,
    targetCommit: "0123456789abcdef0123456789abcdef01234567",
    contractVersion: "1",
    testDataVersion: "v1",
    gatePolicyVersion: "v1",
    idempotencyKey: key,
    status: "CREATED",
    createdAt: fixedClock.now(),
  });
  store.createProject(project);
  store.createTask(task);
  store.createRun(makeRun("RUN-001", "key-1"));
  store.createRun(makeRun("RUN-002", "key-2"));
  const manager = new RuntimeManager(
    resolveAcceptanceHome(join(root, "cap-home")),
    store,
    fixedClock,
  );
  const first = manager.allocate(project.id, task.id, "RUN-001", 19000);
  const second = manager.allocate(project.id, task.id, "RUN-002", 19000);
  assert.equal(first.port, 19000);
  assert.equal(second.port, 19001);
  assert.notEqual(first.path, second.path);
  assert.equal(
    store.listLeases("RUN-001").filter((lease) => lease.status === "ACTIVE")
      .length,
    2,
  );
  manager.release(first);
  assert.equal(store.findActiveLease("port", "19000"), undefined);
  manager.release(second);
  store.close();
  await rm(root, { recursive: true, force: true });
});
