import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { Project } from "../../src/domain.js";
import { mirrorAcceptedRefs } from "../../src/forgejo.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}

test("accepted Forgejo refs are fetched before non-deleting backup mirror", async () => {
  const root = await mkdtemp(join(process.cwd(), ".test-forgejo-mirror-"));
  const authority = join(root, "authority.git");
  const backup = join(root, "backup.git");
  const source = join(root, "source");
  const checkout = join(root, "checkout");
  try {
    execFileSync("git", ["init", "--bare", authority]);
    execFileSync("git", ["init", "--bare", backup]);
    execFileSync("git", ["init", "-b", "master", source]);
    git(source, "config", "user.name", "CAP Test");
    git(source, "config", "user.email", "cap@example.invalid");
    git(source, "commit", "--allow-empty", "-m", "first");
    git(source, "remote", "add", "origin", authority);
    git(source, "push", "-u", "origin", "master");
    execFileSync("git", ["clone", authority, checkout]);
    git(checkout, "remote", "add", "github", backup);
    git(source, "commit", "--allow-empty", "-m", "accepted");
    git(source, "push", "origin", "master");
    const acceptedCommit = git(source, "rev-parse", "HEAD");
    const staleLocalCommit = git(checkout, "rev-parse", "master");
    assert.notEqual(staleLocalCommit, acceptedCommit);

    const now = "2026-08-28T00:00:00.000Z";
    const project: Project = {
      id: "mirror-test",
      name: "Mirror test",
      repoPath: checkout,
      baseBranch: "master",
      configPath: join(checkout, ".acceptance", "project.yaml"),
      status: "ACTIVE",
      createdAt: now,
      updatedAt: now,
    };
    mirrorAcceptedRefs(project, "github", acceptedCommit);

    assert.equal(
      execFileSync("git", ["--git-dir", backup, "rev-parse", "master"], {
        encoding: "utf8",
      }).trim(),
      acceptedCommit,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
