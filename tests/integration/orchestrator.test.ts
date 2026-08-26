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

function git(repoPath: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
  });
  assert.equal(result.status, 0, `${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

test("orchestrator executes a fake-reviewed run through the deterministic gate", async () => {
  const root = await mkdtemp(join(process.cwd(), ".test-orchestrator-"));
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
      "project_id: cap-e2e",
      "display_name: CAP E2E",
      "repository:",
      "  base_branch: main",
      "  require_clean_submission: true",
      "commands:",
      "  build:",
      "    - node --version",
      "  unit:",
      "    - node --version",
      "reviewer:",
      "  provider: fake",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(repo, ".acceptance", "contract.yaml"),
    [
      "version: 1",
      "contract_id: contract-e2e",
      "task_id: TASK-E2E",
      "title: Orchestrated acceptance",
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
  const target = git(repo, "rev-parse", "HEAD");

  const home = resolveAcceptanceHome(join(root, "cap-home"));
  const store = new SqliteStore(join(home.state, "acceptance.sqlite"));
  try {
    const controller = new AcceptanceController({
      store,
      git: new CliGitClient(),
    });
    const project = controller.registerProject(
      {
        version: 1,
        project_id: "cap-e2e",
        display_name: "CAP E2E",
        repository: { base_branch: "main", require_clean_submission: true },
        commands: { build: ["node --version"], unit: ["node --version"] },
        reviewer: { provider: "fake" },
      },
      join(repo, ".acceptance", "project.yaml"),
    );
    const contract = {
      version: 1 as const,
      contract_id: "contract-e2e",
      task_id: "TASK-E2E",
      title: "Orchestrated acceptance",
      requirements: [
        {
          id: "AC-CORE",
          title: "Core behavior",
          criticality: "core" as const,
          verification: { modes: ["unit"], required_evidence: "E2" as const },
        },
      ],
    };
    const submitted = controller.submit(
      project,
      {
        version: 1,
        project_id: "cap-e2e",
        display_name: "CAP E2E",
        repository: { base_branch: "main", require_clean_submission: true },
        commands: { build: ["node --version"], unit: ["node --version"] },
        reviewer: { provider: "fake" },
      },
      contract,
      join(repo, ".acceptance", "contract.yaml"),
      target,
    );
    const executed = await new AcceptanceRunExecutor({
      store,
      home,
      git: new CliGitClient(),
      reviewerSchemaPath: join(
        process.cwd(),
        "schemas",
        "reviewer-report.schema.json",
      ),
    }).execute(submitted.run.id);
    assert.equal(executed.gate.decision, "PASS");
    assert.equal(executed.run.status, "COMPLETED_PASS");
    assert.equal(executed.task.status, "ACCEPTED");
    assert.equal(store.getRun(submitted.run.id).reviewerThreadId, undefined);
    const artifactRoot = join(
      home.projects,
      "cap-e2e",
      "runs",
      "TASK-E2E",
      submitted.run.id,
    );
    assert.match(
      await readFile(join(artifactRoot, "reviewer", "report.json"), "utf8"),
      /AC-CORE/,
    );
    assert.match(
      await readFile(join(artifactRoot, "evidence", "index.json"), "utf8"),
      /verifier\/summary.json/,
    );
    assert.match(
      await readFile(
        join(artifactRoot, "acceptance", "gate-decision.json"),
        "utf8",
      ),
      /ALL_GATES_SATISFIED/,
    );
    assert.equal(
      store
        .listLeases(submitted.run.id)
        .filter((lease) => lease.status === "ACTIVE").length,
      0,
    );
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
