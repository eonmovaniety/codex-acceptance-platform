import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { AcceptanceRun, Project, Task } from "../../src/domain.js";
import { ArtifactStore } from "../../src/artifacts.js";
import { DashboardApi, DashboardServer } from "../../src/dashboard.js";
import { resolveAcceptanceHome } from "../../src/paths.js";
import { SqliteStore } from "../../src/storage.js";

test("dashboard API exposes projects, timeline, coverage, artifacts, and retention read-only", async () => {
  const root = await mkdtemp(join(process.cwd(), ".test-dashboard-"));
  const home = resolveAcceptanceHome(join(root, "home"));
  const store = new SqliteStore(join(home.state, "acceptance.sqlite"));
  const project: Project = {
    id: "project",
    name: "Project",
    repoPath: root,
    baseBranch: "main",
    configPath: join(root, ".acceptance", "project.yaml"),
    status: "ACTIVE",
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
  };
  const run: AcceptanceRun = {
    id: "RUN-DASHBOARD",
    projectId: project.id,
    taskId: "TASK-001",
    targetCommit: "0123456789abcdef0123456789abcdef01234567",
    contractVersion: "1",
    testDataVersion: "v1",
    gatePolicyVersion: "v1",
    idempotencyKey: "dashboard-key",
    status: "COMPLETED_PASS",
    decision: "PASS",
    createdAt: "2026-08-27T00:00:00.000Z",
    startedAt: "2026-08-27T00:00:00.000Z",
    completedAt: "2026-08-27T00:00:01.000Z",
  };
  store.createProject(project);
  const task: Task = {
    id: "TASK-001",
    projectId: project.id,
    title: "Dashboard task",
    status: "ACCEPTED",
    riskLevel: "R1",
    failureCount: 0,
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
  };
  store.createTask(task);
  store.createRun(run);
  store.appendEvent(run.id, "GateDecided", { decision: "PASS" });
  const artifacts = new ArtifactStore(home);
  artifacts.writeJson(
    project.id,
    run.taskId,
    run.id,
    "acceptance/matrix.json",
    {
      version: 1,
      run_id: run.id,
      requirements: [],
      coverage: {
        total: 0,
        pass: 0,
        fail: 0,
        not_tested: 0,
        blocked: 0,
        not_applicable: 0,
      },
    },
  );
  artifacts.writeText(
    project.id,
    run.taskId,
    run.id,
    "notes.txt",
    "dashboard evidence\n",
  );
  const server = new DashboardServer(new DashboardApi(store, artifacts, home));
  const port = await server.listen(0);
  try {
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);
    assert.equal(((await health.json()) as { ok: boolean }).ok, true);
    const writeAttempt = await fetch(`http://127.0.0.1:${port}/api/projects`, {
      method: "POST",
      body: "{}",
    });
    assert.equal(writeAttempt.status, 405);
    const projects = await fetch(`http://127.0.0.1:${port}/api/projects`);
    assert.equal(
      ((await projects.json()) as { projects: Project[] }).projects[0]?.id,
      "project",
    );
    const timeline = await fetch(
      `http://127.0.0.1:${port}/api/runs/${run.id}/timeline`,
    );
    assert.equal(
      ((await timeline.json()) as { events: unknown[] }).events.length,
      1,
    );
    const coverage = await fetch(
      `http://127.0.0.1:${port}/api/runs/${run.id}/coverage`,
    );
    assert.equal(
      ((await coverage.json()) as { available: boolean }).available,
      true,
    );
    const listed = await fetch(
      `http://127.0.0.1:${port}/api/runs/${run.id}/artifacts`,
    );
    assert.ok(
      ((await listed.json()) as { artifacts: string[] }).artifacts.includes(
        "notes.txt",
      ),
    );
    const artifact = await fetch(
      `http://127.0.0.1:${port}/api/runs/${run.id}/artifacts/notes.txt`,
    );
    assert.equal(await artifact.text(), "dashboard evidence\n");
    const retention = await fetch(`http://127.0.0.1:${port}/api/retention`);
    assert.equal(
      ((await retention.json()) as { plan: { items: unknown[] } }).plan.items
        .length,
      1,
    );
  } finally {
    await server.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
