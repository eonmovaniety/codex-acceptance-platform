import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import { AcceptanceController } from "../../src/controller.js";
import { CliGitClient } from "../../src/git.js";
import { AcceptanceRunExecutor } from "../../src/orchestrator.js";
import { resolveAcceptanceHome } from "../../src/paths.js";
import { SqliteStore } from "../../src/storage.js";
import type { CommandResult, CommandRunner } from "../../src/runner.js";

function git(repoPath: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
  });
  assert.equal(result.status, 0, `${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

class FailOnceRunner implements CommandRunner {
  private calls = 0;

  run(command: string): CommandResult {
    this.calls += 1;
    const failed = this.calls === 1;
    return {
      command,
      executable: "node",
      args: ["--version"],
      exitCode: failed ? 1 : 0,
      stdout: failed ? "" : "v24.16.0\n",
      stderr: failed ? "intentional test failure\n" : "",
      durationMs: 1,
      timedOut: false,
    };
  }
}

test("FAIL creates a failure package and a new commit can pass in a fresh Run", async () => {
  const root = await mkdtemp(join(process.cwd(), ".test-failure-loop-"));
  const repo = join(root, "repo");
  await mkdir(join(repo, ".acceptance"), { recursive: true });
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "CAP Test");
  git(repo, "config", "user.email", "cap@example.invalid");
  await writeFile(join(repo, "README.md"), "target\n", "utf8");
  await writeFile(
    join(repo, ".acceptance", "project.yaml"),
    [
      "version: 1",
      "project_id: failure-loop",
      "display_name: Failure loop",
      "repository:",
      "  base_branch: main",
      "  require_clean_submission: true",
      "commands:",
      "  build:",
      "    - node --version",
      "  unit:",
      "    - node --version",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(repo, ".acceptance", "contract.yaml"),
    [
      "version: 1",
      "contract_id: failure-contract",
      "task_id: TASK-FAIL",
      "title: Failure loop",
      "requirements:",
      "  - id: AC-CORE",
      "    title: Core behavior",
      "    criticality: core",
      "    verification:",
      "      modes: [unit]",
      "      required_evidence: E2",
      "",
    ].join("\n"),
    "utf8",
  );
  git(repo, "add", ".");
  git(repo, "commit", "-m", "target");
  const firstCommit = git(repo, "rev-parse", "HEAD");
  const home = resolveAcceptanceHome(join(root, "cap-home"));
  const store = new SqliteStore(join(home.state, "acceptance.sqlite"));
  try {
    const gitClient = new CliGitClient();
    const controller = new AcceptanceController({ store, git: gitClient });
    const config = {
      version: 1 as const,
      project_id: "failure-loop",
      display_name: "Failure loop",
      repository: { base_branch: "main", require_clean_submission: true },
      commands: { build: ["node --version"], unit: ["node --version"] },
      reviewer: { provider: "fake" as const },
    };
    const contract = {
      version: 1 as const,
      contract_id: "failure-contract",
      task_id: "TASK-FAIL",
      title: "Failure loop",
      requirements: [
        {
          id: "AC-CORE",
          title: "Core behavior",
          criticality: "core" as const,
          verification: { modes: ["unit"], required_evidence: "E2" as const },
        },
      ],
    };
    const project = controller.registerProject(
      config,
      join(repo, ".acceptance", "project.yaml"),
    );
    const first = controller.submit(
      project,
      config,
      contract,
      join(repo, ".acceptance", "contract.yaml"),
      firstCommit,
    );
    const runner = new FailOnceRunner();
    const executor = new AcceptanceRunExecutor({
      store,
      home,
      git: gitClient,
      commandRunner: runner,
      reviewerSchemaPath: join(
        process.cwd(),
        "schemas",
        "reviewer-report.schema.json",
      ),
    });
    const failed = await executor.execute(first.run.id);
    assert.equal(failed.gate.decision, "FAIL");
    assert.equal(failed.run.status, "COMPLETED_FAIL");
    assert.equal(failed.task.status, "FIX_REQUESTED");
    const oldRoot = join(
      home.projects,
      project.id,
      "runs",
      contract.task_id,
      first.run.id,
    );
    assert.match(
      await readFile(join(oldRoot, "failure", "failure-package.json"), "utf8"),
      /AC-CORE/,
    );
    assert.match(
      await readFile(join(oldRoot, "failure", "fix-request.json"), "utf8"),
      /AUTO_FIX/,
    );
    assert.match(
      await readFile(join(oldRoot, "failure", "impact-analysis.json"), "utf8"),
      /core-smoke/,
    );
    assert.equal(store.getTask(project.id, contract.task_id).failureCount, 1);

    controller.beginFix(project.id, contract.task_id);
    await writeFile(join(repo, "README.md"), "fixed\n", "utf8");
    git(repo, "add", "README.md");
    git(repo, "commit", "-m", "fix");
    const secondCommit = git(repo, "rev-parse", "HEAD");
    const second = controller.submit(
      project,
      config,
      contract,
      join(repo, ".acceptance", "contract.yaml"),
      secondCommit,
    );
    assert.notEqual(second.run.id, first.run.id);
    const passed = await executor.execute(second.run.id);
    assert.equal(passed.gate.decision, "PASS");
    assert.equal(passed.task.status, "ACCEPTED");
    assert.notEqual(
      store.getRun(first.run.id).reviewerThreadId,
      store.getRun(second.run.id).reviewerThreadId,
    );
    assert.equal(store.getRun(first.run.id).targetCommit, firstCommit);
    assert.equal(store.getRun(second.run.id).targetCommit, secondCommit);
    assert.match(
      await readFile(join(oldRoot, "failure", "failure-package.json"), "utf8"),
      /AC-CORE/,
    );
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
