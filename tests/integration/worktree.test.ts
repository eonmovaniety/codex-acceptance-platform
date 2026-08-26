import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import { CliGitClient } from "../../src/git.js";
import { resolveAcceptanceHome } from "../../src/paths.js";
import { WorktreeManager } from "../../src/worktree.js";

function git(repoPath: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
  });
  assert.equal(result.status, 0, `${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

test("worktree is detached at target and captures reviewer dirt separately", async () => {
  const root = await mkdtemp(join(process.cwd(), ".test-worktree-"));
  const repo = join(root, "repo");
  await mkdir(repo, { recursive: true });
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "CAP Test");
  git(repo, "config", "user.email", "cap@example.invalid");
  await writeFile(join(repo, "state.txt"), "target\n", "utf8");
  git(repo, "add", "state.txt");
  git(repo, "commit", "-m", "target");
  const target = git(repo, "rev-parse", "HEAD");
  const home = resolveAcceptanceHome(join(root, "cap-home"));
  const manager = new WorktreeManager(home, new CliGitClient());
  const record = manager.create("project", "RUN-001", repo, target);

  await writeFile(join(repo, "state.txt"), "builder continues\n", "utf8");
  assert.equal(
    (await readFile(join(record.path, "state.txt"), "utf8")).replaceAll(
      "\r\n",
      "\n",
    ),
    "target\n",
  );
  await writeFile(join(record.path, "state.txt"), "reviewer patch\n", "utf8");
  const dirty = manager.captureDirtyState(record);
  assert.equal(dirty.head, target);
  assert.equal(dirty.dirty, true);
  assert.match(dirty.patch, /reviewer patch/);

  const reset = manager.resetToTarget(record);
  assert.equal(
    (await readFile(join(reset.path, "state.txt"), "utf8")).replaceAll(
      "\r\n",
      "\n",
    ),
    "target\n",
  );
  manager.remove(reset);
  assert.equal(await exists(record.path), false);
  await rm(root, { recursive: true, force: true });
});

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}
