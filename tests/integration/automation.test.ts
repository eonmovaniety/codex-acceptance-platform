import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type {
  AcceptanceContract,
  AcceptanceRun,
  ProjectConfig,
  Task,
} from "../../src/domain.js";
import { ArtifactStore } from "../../src/artifacts.js";
import {
  AutomationService,
  AutomationWorker,
  installAutomation,
  uninstallAutomation,
  validateAutomationConfig,
} from "../../src/automation.js";
import { AcceptanceController } from "../../src/controller.js";
import { CliGitClient, type GitClient } from "../../src/git.js";
import { createIdempotencyKey } from "../../src/ids.js";
import {
  buildAcceptanceSummary,
  createNotificationOutbox,
  formatNotification,
  NotificationDispatcher,
  type Notifier,
} from "../../src/notifications.js";
import { resolveAcceptanceHome } from "../../src/paths.js";
import { SqliteStore, type Clock } from "../../src/storage.js";

const targetCommit = "0123456789abcdef0123456789abcdef01234567";
const fixedClock: Clock = { now: () => "2026-08-27T00:00:00.000Z" };

class FakeGit implements GitClient {
  status = "";

  constructor(
    private readonly root: string,
    private readonly target = targetCommit,
  ) {}

  repoRoot(): string {
    return this.root;
  }

  gitDir(): string {
    return join(this.root, ".git");
  }

  resolveCommit(): string {
    return this.target;
  }

  statusPorcelain(): string {
    return this.status;
  }

  diff(): string {
    return "";
  }

  untrackedFiles(): string[] {
    return [];
  }

  addDetachedWorktree(): void {}

  removeWorktree(): void {}

  resetHard(): void {}

  cleanUntracked(): void {}

  pruneWorktrees(): void {}

  version(): string {
    return "fake-git";
  }
}

interface Fixture {
  root: string;
  home: ReturnType<typeof resolveAcceptanceHome>;
  store: SqliteStore;
  git: FakeGit;
  project: ReturnType<AcceptanceController["registerProject"]>;
  config: ProjectConfig;
  contract: AcceptanceContract;
  contractPath: string;
}

function configFor(projectId: string): ProjectConfig {
  return {
    version: 1,
    project_id: projectId,
    display_name: "Automation fixture",
    repository: { base_branch: "master", require_clean_submission: true },
    test_data: { version: "v1" },
    gate: { policy_version: "policy-v1" },
    automation: {
      enabled: true,
      tasks: [
        {
          task_id: "TASK-001",
          contract: ".acceptance/contract.yaml",
        },
      ],
      local: {
        post_commit: true,
        worker: "login_resident",
        poll_seconds: 1,
        concurrency: 1,
      },
      ci: {
        provider: "github-actions",
        pull_request: true,
        push_branches: ["master"],
        authoritative: true,
      },
      retry: { infrastructure_max_attempts: 1 },
      notifications: {
        terminal: true,
        windows_toast: false,
        ci_summary: true,
        progress_after_seconds: 1,
        progress_interval_seconds: 1,
      },
    },
  };
}

const contractFor: AcceptanceContract = {
  version: 1,
  contract_id: "TASK-001-v1",
  task_id: "TASK-001",
  title: "Automation contract",
  risk_level: "R1",
  requirements: [
    {
      id: "AC-01",
      title: "Automated acceptance is traceable",
      criticality: "core",
      verification: { modes: ["unit"], required_evidence: "E2" },
    },
  ],
};

async function createFixture(
  projectId = "automation-fixture",
  homeRoot?: string,
): Promise<Fixture> {
  const root = await mkdtemp(join(process.cwd(), ".test-automation-"));
  const acceptance = join(root, ".acceptance");
  await mkdir(join(root, ".git", "hooks"), { recursive: true });
  await mkdir(acceptance, { recursive: true });
  const config = configFor(projectId);
  const configPath = join(acceptance, "project.yaml");
  const contractPath = join(acceptance, "contract.yaml");
  await writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
  await writeFile(contractPath, JSON.stringify(contractFor, null, 2), "utf8");
  const home = resolveAcceptanceHome(homeRoot ?? join(root, "home"));
  const store = new SqliteStore(
    join(home.state, "acceptance.sqlite"),
    fixedClock,
  );
  const git = new FakeGit(root);
  const controller = new AcceptanceController({
    store,
    git,
    clock: fixedClock,
  });
  const project = controller.registerProject(config, configPath);
  return {
    root,
    home,
    store,
    git,
    project,
    config,
    contract: contractFor,
    contractPath,
  };
}

async function closeFixture(fixture: Fixture): Promise<void> {
  fixture.store.close();
  await rm(fixture.root, { recursive: true, force: true });
}

function silentDispatcher(
  fixture: Fixture,
  calls: string[] = [],
): NotificationDispatcher {
  const notifier: Notifier = {
    channel: "terminal",
    async send(event) {
      calls.push(event.event_type);
      return { status: "SENT" };
    },
  };
  return new NotificationDispatcher({
    store: fixture.store,
    artifacts: new ArtifactStore(fixture.home),
    home: fixture.home,
    notifiers: [notifier],
    clock: fixedClock,
  });
}

test("automation configuration validates tasks, concurrency, and retry policy", () => {
  const config = configFor("config-validation");
  assert.doesNotThrow(() => validateAutomationConfig(config));
  assert.throws(
    () =>
      validateAutomationConfig({
        ...config,
        automation: {
          ...config.automation!,
          tasks: [...config.automation!.tasks!, config.automation!.tasks![0]!],
        },
      }),
    /duplicate task_id/,
  );
  assert.throws(
    () =>
      validateAutomationConfig({
        ...config,
        automation: {
          ...config.automation!,
          local: { ...config.automation!.local!, concurrency: 2 },
        },
      }),
    /concurrency = 1/,
  );
});

test("local and CI automation runs are isolated and idempotent", async () => {
  const fixture = await createFixture("automation-isolation");
  try {
    const calls: string[] = [];
    const notifications = silentDispatcher(fixture, calls);
    const service = new AutomationService({
      store: fixture.store,
      home: fixture.home,
      git: fixture.git,
      clock: fixedClock,
      notifications,
    });
    const local = await service.enqueue({
      projectId: fixture.project.id,
      taskId: "TASK-001",
      commit: "HEAD",
      source: "post_commit",
    });
    const ci = await service.enqueue({
      projectId: fixture.project.id,
      taskId: "TASK-001",
      commit: "HEAD",
      source: "ci_pull_request",
      eventId: "pull-request-event-1",
    });
    const duplicate = await service.enqueue({
      projectId: fixture.project.id,
      taskId: "TASK-001",
      commit: "HEAD",
      source: "post_commit",
    });

    assert.equal(local.existing, false);
    assert.equal(ci.existing, false);
    assert.equal(duplicate.existing, true);
    assert.notEqual(local.run?.id, ci.run?.id);
    assert.equal(local.run?.executionScope, "local");
    assert.equal(ci.run?.executionScope, "ci");
    assert.equal(local.run?.triggerSource, "post_commit");
    assert.equal(ci.run?.triggerSource, "ci_pull_request");
    assert.equal(
      fixture.store.listRuns(fixture.project.id, "TASK-001").length,
      2,
    );
    assert.equal(
      fixture.store.listAutomationJobs(fixture.project.id).length,
      2,
    );
    assert.equal(
      calls.filter((event) => event === "automation.enqueued").length,
      2,
    );

    const base = createIdempotencyKey(
      "p",
      "t",
      targetCommit,
      "contract",
      "v1",
      "policy-v1",
      "local",
    );
    assert.notEqual(
      base,
      createIdempotencyKey(
        "p",
        "t",
        targetCommit,
        "contract",
        "v2",
        "policy-v1",
        "local",
      ),
    );
    assert.notEqual(
      base,
      createIdempotencyKey(
        "p",
        "t",
        targetCommit,
        "contract",
        "v1",
        "policy-v1",
        "ci",
      ),
    );
  } finally {
    await closeFixture(fixture);
  }
});

test("a newer commit starts a fresh run after the previous commit was accepted", async () => {
  const fixture = await createFixture("automation-after-accepted");
  try {
    const first = await new AutomationService({
      store: fixture.store,
      home: fixture.home,
      git: fixture.git,
      clock: fixedClock,
      notifications: silentDispatcher(fixture),
    }).enqueue({
      projectId: fixture.project.id,
      taskId: "TASK-001",
      commit: "HEAD",
      source: "ci_push",
      eventId: "accepted-commit-1",
    });
    fixture.store.updateTask({
      ...fixture.store.getTask(fixture.project.id, "TASK-001"),
      status: "ACCEPTED",
      acceptedCommit: first.run!.targetCommit,
      updatedAt: fixedClock.now(),
    });

    const nextCommit = "abcdef0123456789abcdef0123456789abcdef01";
    const second = await new AutomationService({
      store: fixture.store,
      home: fixture.home,
      git: new FakeGit(fixture.root, nextCommit),
      clock: fixedClock,
      notifications: silentDispatcher(fixture),
    }).enqueue({
      projectId: fixture.project.id,
      taskId: "TASK-001",
      commit: "HEAD",
      source: "ci_pull_request",
      eventId: "accepted-commit-2",
    });

    assert.equal(second.job.status, "QUEUED");
    assert.equal(second.run?.targetCommit, nextCommit);
    assert.equal(
      fixture.store.getTask(fixture.project.id, "TASK-001").status,
      "IN_ACCEPTANCE",
    );
    assert.equal(
      fixture.store.getTask(fixture.project.id, "TASK-001").acceptedCommit,
      first.run!.targetCommit,
    );
  } finally {
    await closeFixture(fixture);
  }
});

test("dirty submissions become BLOCKED without mixing uncommitted files", async () => {
  const fixture = await createFixture("automation-dirty");
  try {
    fixture.git.status = " M source.ts";
    const result = await new AutomationService({
      store: fixture.store,
      home: fixture.home,
      git: fixture.git,
      clock: fixedClock,
      notifications: silentDispatcher(fixture),
    }).enqueue({
      projectId: fixture.project.id,
      taskId: "TASK-001",
      commit: "HEAD",
      source: "post_commit",
    });
    assert.equal(result.job.status, "BLOCKED");
    assert.equal(result.run?.status, "BLOCKED");
    assert.equal(
      fixture.store.listRuns(fixture.project.id, "TASK-001").length,
      1,
    );
    const blockedPaths = new ArtifactStore(fixture.home).listRelativePaths(
      fixture.project.id,
      "TASK-001",
      result.run!.id,
    );
    assert.ok(blockedPaths.includes("acceptance/summary.json"));
  } finally {
    await closeFixture(fixture);
  }
});

test("dirty source worktree does not block an exact-SHA CI run", async () => {
  const fixture = await createFixture("automation-dirty-ci");
  try {
    fixture.git.status = " M user-work.ts";
    const result = await new AutomationService({
      store: fixture.store,
      home: fixture.home,
      git: fixture.git,
      clock: fixedClock,
      notifications: silentDispatcher(fixture),
    }).enqueue({
      projectId: fixture.project.id,
      taskId: "TASK-001",
      commit: targetCommit,
      source: "ci_pull_request",
      eventId: `forgejo:test/repo:pr:1:${targetCommit}`,
    });
    assert.equal(result.job.status, "QUEUED");
    assert.equal(result.run?.status, "CREATED");
    assert.equal(result.run?.executionScope, "ci");
  } finally {
    await closeFixture(fixture);
  }
});

test("SQLite lease prevents duplicate workers and permits recovery after expiry", async () => {
  const fixture = await createFixture("automation-lease");
  try {
    const result = await new AutomationService({
      store: fixture.store,
      home: fixture.home,
      git: fixture.git,
      clock: fixedClock,
      notifications: silentDispatcher(fixture),
    }).enqueue({
      projectId: fixture.project.id,
      taskId: "TASK-001",
      commit: "HEAD",
      source: "post_commit",
    });
    const first = fixture.store.claimNextAutomationJob(
      "worker-a",
      "2026-08-27T00:01:00.000Z",
      fixedClock.now(),
    );
    assert.equal(first?.id, result.job.id);
    assert.equal(
      fixture.store.claimNextAutomationJob(
        "worker-b",
        "2026-08-27T00:01:00.000Z",
        fixedClock.now(),
      ),
      undefined,
    );
    const recovered = fixture.store.claimNextAutomationJob(
      "worker-b",
      "2026-08-27T00:02:00.000Z",
      "2026-08-27T00:01:00.000Z",
    );
    assert.equal(recovered?.id, result.job.id);
    assert.equal(recovered?.attempts, 2);
  } finally {
    await closeFixture(fixture);
  }
});

test("infrastructure retry creates a new Attempt Run and wait follows it", async () => {
  const fixture = await createFixture("automation-retry");
  try {
    const result = await new AutomationService({
      store: fixture.store,
      home: fixture.home,
      git: fixture.git,
      clock: fixedClock,
      notifications: silentDispatcher(fixture),
    }).enqueue({
      projectId: fixture.project.id,
      taskId: "TASK-001",
      commit: "HEAD",
      source: "ci_pull_request",
    });
    let executions = 0;
    const worker = new AutomationWorker({
      store: fixture.store,
      home: fixture.home,
      git: fixture.git,
      clock: fixedClock,
      notifications: silentDispatcher(fixture),
      executor: async (runId) => {
        executions += 1;
        const run = fixture.store.getRun(runId);
        if (executions === 1) {
          fixture.store.updateRun({ ...run, status: "INFRA_FAILED" });
          throw new Error("simulated infrastructure outage");
        }
        const completed: AcceptanceRun = {
          ...run,
          status: "COMPLETED_PASS",
          decision: "PASS",
          startedAt: run.startedAt ?? fixedClock.now(),
          completedAt: fixedClock.now(),
        };
        fixture.store.updateRun(completed);
        return {} as never;
      },
    });
    const first = await worker.runOnce();
    assert.equal(first.job?.status, "RETRY_WAIT");
    assert.equal(first.run?.attempt, 2);
    assert.equal(first.run?.retryOf, result.run?.id);

    const retryJob = fixture.store.getAutomationJob(result.job.id);
    fixture.store.updateAutomationJob({
      ...retryJob,
      nextAttemptAt: fixedClock.now(),
      updatedAt: fixedClock.now(),
    });
    const final = await worker.runUntil(result.run!.id, 2_000);
    assert.equal(final.status, "COMPLETED_PASS");
    assert.equal(final.attempt, 2);
    assert.equal(executions, 2);
    assert.equal(
      fixture.store.getAutomationJob(result.job.id).status,
      "SUCCEEDED",
    );
  } finally {
    await closeFixture(fixture);
  }
});

test("notification delivery retries without changing the Gate result and redacts secrets", async () => {
  const fixture = await createFixture("automation-notifications");
  try {
    const task: Task = {
      id: "TASK-001",
      projectId: fixture.project.id,
      title: "Automation contract",
      status: "IN_ACCEPTANCE",
      riskLevel: "R1",
      failureCount: 0,
      createdAt: fixedClock.now(),
      updatedAt: fixedClock.now(),
    };
    fixture.store.createTask(task);
    const run: AcceptanceRun = {
      id: "RUN-NOTIFICATION",
      projectId: fixture.project.id,
      taskId: task.id,
      targetCommit,
      contractVersion: "1",
      testDataVersion: "v1",
      gatePolicyVersion: "policy-v1",
      idempotencyKey: "notification-run",
      status: "COMPLETED_PASS",
      decision: "PASS",
      triggerSource: "post_commit",
      executionScope: "local",
      createdAt: fixedClock.now(),
      startedAt: fixedClock.now(),
      completedAt: fixedClock.now(),
    };
    fixture.store.createRun(run);
    const summary = buildAcceptanceSummary({ run, project: fixture.project });
    assert.equal(summary.status, "COMPLETED_PASS");
    assert.equal(summary.notification_deliveries instanceof Object, true);

    let attempts = 0;
    const flaky: Notifier = {
      channel: "terminal",
      async send() {
        attempts += 1;
        return attempts === 1
          ? { status: "FAILED", error: "terminal unavailable" }
          : { status: "SENT" };
      },
    };
    const outbox = createNotificationOutbox({
      eventType: "automation.completed",
      runId: run.id,
      source: "post_commit",
      channels: ["terminal"],
      payload: { status: run.status },
      dedupeSuffix: "test",
      now: fixedClock.now,
    });
    fixture.store.createNotificationOutbox(outbox);
    const dispatcher = new NotificationDispatcher({
      store: fixture.store,
      artifacts: new ArtifactStore(fixture.home),
      home: fixture.home,
      notifiers: [flaky],
      clock: fixedClock,
    });
    await dispatcher.dispatchPending();
    assert.equal(fixture.store.getRun(run.id).status, "COMPLETED_PASS");
    assert.equal(
      fixture.store.getNotificationOutbox(outbox.id).status,
      "FAILED",
    );
    fixture.store.updateNotificationOutbox({
      ...fixture.store.getNotificationOutbox(outbox.id),
      nextAttemptAt: fixedClock.now(),
    });
    await dispatcher.dispatchPending();
    assert.equal(fixture.store.getNotificationOutbox(outbox.id).status, "SENT");
    assert.equal(
      fixture.store.listNotificationDeliveries(outbox.id)[0]?.attempts,
      2,
    );
    assert.match(
      formatNotification({
        version: 1,
        id: "redaction",
        event_type: "automation.failed",
        channels: ["terminal"],
        message: "token=super-secret password=another-secret",
        created_at: fixedClock.now(),
      }),
      /\[REDACTED_SECRET\]/,
    );
    assert.doesNotMatch(
      formatNotification({
        version: 1,
        id: "redaction",
        event_type: "automation.failed",
        channels: ["terminal"],
        message: "token=super-secret password=another-secret",
        created_at: fixedClock.now(),
      }),
      /super-secret|another-secret/,
    );
  } finally {
    await closeFixture(fixture);
  }
});

test("install and uninstall preserves an existing post-commit hook", async () => {
  const fixture = await createFixture("automation-install");
  try {
    const hookPath = join(fixture.root, ".git", "hooks", "post-commit");
    const original = "#!/bin/sh\necho existing-hook\n";
    await writeFile(hookPath, original, "utf8");
    const schedulerCalls: string[] = [];
    const scheduler = {
      createLoginTask(name: string, command: string): void {
        schedulerCalls.push(`create:${name}:${command}`);
      },
      deleteTask(name: string): void {
        schedulerCalls.push(`delete:${name}`);
      },
      runTask(name: string): void {
        schedulerCalls.push(`run:${name}`);
      },
    };
    const record = installAutomation({
      projectId: fixture.project.id,
      taskId: "TASK-001",
      repoPath: fixture.root,
      git: fixture.git,
      home: fixture.home,
      cliPath: join(fixture.root, "cap-cli.js"),
      scheduler,
      now: fixedClock.now,
    });
    const managed = await readFile(hookPath, "utf8");
    assert.match(managed, /CAP_AUTOMATION_HOOK_BEGIN/);
    assert.match(managed, /original-post-commit/);
    assert.equal(record.project_id, fixture.project.id);
    if (process.platform === "win32") {
      assert.equal(schedulerCalls.length, 2);
      assert.match(schedulerCalls[0]!, /^create:/);
      assert.match(schedulerCalls[1]!, /^run:/);
    }
    const removed = uninstallAutomation({
      repoPath: fixture.root,
      git: fixture.git,
      scheduler,
    });
    assert.equal(removed.restored, true);
    assert.equal(await readFile(hookPath, "utf8"), original);
    if (process.platform === "win32")
      assert.equal(schedulerCalls.at(-1)?.startsWith("delete:"), true);
  } finally {
    await closeFixture(fixture);
  }
});

test("failed Worker registration rolls back the managed Hook and record", async () => {
  const fixture = await createFixture("automation-install-rollback");
  try {
    if (process.platform !== "win32") return;
    assert.throws(
      () =>
        installAutomation({
          projectId: fixture.project.id,
          taskId: "TASK-001",
          repoPath: fixture.root,
          git: fixture.git,
          home: fixture.home,
          cliPath: join(fixture.root, "cap-cli.js"),
          scheduler: {
            createLoginTask(): void {
              throw new Error("access denied");
            },
            deleteTask(): void {},
            runTask(): void {},
          },
          now: fixedClock.now,
        }),
      /access denied/,
    );
    assert.equal(
      await readFile(
        join(fixture.root, ".git", "hooks", "post-commit"),
        "utf8",
      ).catch(() => undefined),
      undefined,
    );
    assert.equal(
      await readFile(
        join(fixture.root, ".git", "cap-automation", "installation.json"),
        "utf8",
      ).catch(() => undefined),
      undefined,
    );
  } finally {
    await closeFixture(fixture);
  }
});

test("a real Git post-commit invokes enqueue for the exact new commit", async () => {
  const homeRoot = await mkdtemp(join(process.cwd(), ".test-hook-home-"));
  const fixture = await createFixture("automation-hook-e2e", homeRoot);
  const git = new CliGitClient();
  const configPath = join(fixture.root, ".acceptance", "project.yaml");
  const config = {
    ...fixture.config,
    automation: {
      ...fixture.config.automation!,
      notifications: {
        terminal: false,
        windows_toast: false,
        ci_summary: false,
        progress_after_seconds: 1,
        progress_interval_seconds: 1,
      },
    },
  } satisfies ProjectConfig;
  try {
    fixture.store.close();
    await writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
    await writeFile(
      fixture.contractPath,
      JSON.stringify(fixture.contract, null, 2),
      "utf8",
    );
    runGit(fixture.root, ["init"]);
    runGit(fixture.root, ["config", "user.email", "cap@example.test"]);
    runGit(fixture.root, ["config", "user.name", "CAP Test"]);
    runGit(fixture.root, ["add", ".acceptance"]);
    runGit(fixture.root, ["commit", "-m", "initial"]);

    const setupStore = new SqliteStore(
      join(fixture.home.state, "acceptance.sqlite"),
      fixedClock,
    );
    new AcceptanceController({
      store: setupStore,
      git,
      clock: fixedClock,
    }).registerProject(config, configPath);
    setupStore.close();
    const scheduler = {
      createLoginTask(): void {},
      deleteTask(): void {},
      runTask(): void {},
    };
    installAutomation({
      projectId: fixture.project.id,
      taskId: "TASK-001",
      repoPath: fixture.root,
      git,
      home: fixture.home,
      cliPath: join(process.cwd(), "dist", "src", "cli.js"),
      nodePath: process.execPath,
      scheduler,
      now: fixedClock.now,
    });
    await writeFile(join(fixture.root, "trigger.txt"), "trigger\n", "utf8");
    runGit(fixture.root, ["add", "trigger.txt"]);
    runGit(fixture.root, ["commit", "-m", "trigger"]);
    const commit = runGit(fixture.root, ["rev-parse", "HEAD"]);
    const resultStore = new SqliteStore(
      join(fixture.home.state, "acceptance.sqlite"),
      fixedClock,
    );
    try {
      const jobs = resultStore.listAutomationJobs(fixture.project.id);
      assert.equal(jobs.length, 1);
      assert.equal(jobs[0]?.source, "post_commit");
      assert.equal(jobs[0]?.status, "QUEUED");
      assert.equal(resultStore.getRun(jobs[0]!.runId!).targetCommit, commit);
    } finally {
      resultStore.close();
    }
  } finally {
    const installationPath = join(
      fixture.root,
      ".git",
      "cap-automation",
      "installation.json",
    );
    if (await readFile(installationPath, "utf8").catch(() => undefined)) {
      uninstallAutomation({
        repoPath: fixture.root,
        git,
        scheduler: {
          createLoginTask(): void {},
          deleteTask(): void {},
          runTask(): void {},
        },
      });
    }
    try {
      fixture.store.close();
    } catch {
      // The store was closed before the child-process hook ran.
    }
    await rm(fixture.root, { recursive: true, force: true });
    await rm(homeRoot, { recursive: true, force: true });
  }
});

test("the default Worker executes a Run in an asynchronous CAP child process", async () => {
  const root = await mkdtemp(join(process.cwd(), ".test-worker-child-"));
  const homeRoot = await mkdtemp(join(process.cwd(), ".test-worker-home-"));
  const acceptance = join(root, ".acceptance");
  await mkdir(acceptance, { recursive: true });
  const config = {
    ...configFor("automation-worker-child"),
    commands: {
      build: ["node --version"],
      unit: ["node --version"],
    },
    automation: {
      ...configFor("automation-worker-child").automation!,
      notifications: {
        terminal: false,
        windows_toast: false,
        ci_summary: false,
        progress_after_seconds: 1,
        progress_interval_seconds: 1,
      },
    },
  } satisfies ProjectConfig;
  const configPath = join(acceptance, "project.yaml");
  const contractPath = join(acceptance, "contract.yaml");
  await writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
  await writeFile(contractPath, JSON.stringify(contractFor, null, 2), "utf8");
  await writeFile(join(root, "index.js"), "export {};\n", "utf8");
  const git = new CliGitClient();
  const home = resolveAcceptanceHome(homeRoot);
  let store: SqliteStore | undefined;
  try {
    runGit(root, ["init"]);
    runGit(root, ["config", "user.email", "cap@example.test"]);
    runGit(root, ["config", "user.name", "CAP Test"]);
    runGit(root, ["add", "."]);
    runGit(root, ["commit", "-m", "worker child"]);
    store = new SqliteStore(join(home.state, "acceptance.sqlite"), fixedClock);
    const controller = new AcceptanceController({
      store,
      git,
      clock: fixedClock,
    });
    const project = controller.registerProject(config, configPath);
    const enqueued = await new AutomationService({
      store,
      home,
      git,
      clock: fixedClock,
      notifications: new NotificationDispatcher({
        store,
        artifacts: new ArtifactStore(home),
        home,
        notifiers: [],
        clock: fixedClock,
      }),
    }).enqueue({
      projectId: project.id,
      taskId: contractFor.task_id,
      commit: "HEAD",
      source: "post_commit",
    });
    const result = await new AutomationWorker({
      store,
      home,
      git,
      clock: fixedClock,
      notifications: new NotificationDispatcher({
        store,
        artifacts: new ArtifactStore(home),
        home,
        notifiers: [],
        clock: fixedClock,
      }),
    }).runOnce();
    assert.equal(result.processed, true);
    assert.equal(result.job?.status, "SUCCEEDED");
    assert.equal(result.run?.status, "COMPLETED_PASS");
    assert.equal(
      new ArtifactStore(home).exists(
        project.id,
        contractFor.task_id,
        enqueued.run!.id,
        "acceptance/summary.json",
      ),
      true,
    );
  } finally {
    store?.close();
    await rm(root, { recursive: true, force: true });
    await rm(homeRoot, { recursive: true, force: true });
  }
});

function runGit(repoPath: string, args: string[]): string {
  const result = spawnSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, `${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}
