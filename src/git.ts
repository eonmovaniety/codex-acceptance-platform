import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { CapError } from "./errors.js";

export interface GitClient {
  repoRoot(repoPath: string): string;
  gitDir(repoPath: string): string;
  resolveCommit(repoPath: string, commit: string): string;
  statusPorcelain(repoPath: string): string;
  diff(repoPath: string, commit: string): string;
  untrackedFiles(repoPath: string): string[];
  addDetachedWorktree(
    repoPath: string,
    worktreePath: string,
    commit: string,
  ): void;
  removeWorktree(repoPath: string, worktreePath: string): void;
  resetHard(repoPath: string, commit: string): void;
  cleanUntracked(repoPath: string): void;
  pruneWorktrees(repoPath: string): void;
  version(): string;
}

export class CliGitClient implements GitClient {
  repoRoot(repoPath: string): string {
    return this.runGit(
      repoPath,
      ["rev-parse", "--show-toplevel"],
      "Git root could not be resolved",
    );
  }

  gitDir(repoPath: string): string {
    const value = this.runGit(
      repoPath,
      ["rev-parse", "--git-dir"],
      "Git directory could not be resolved",
    );
    return resolve(repoPath, value);
  }

  resolveCommit(repoPath: string, commit: string): string {
    return this.runGit(
      repoPath,
      ["rev-parse", "--verify", `${commit}^{commit}`],
      `Git target commit could not be resolved: ${commit}`,
      "INVALID_TARGET_COMMIT",
    );
  }

  statusPorcelain(repoPath: string): string {
    const result = spawnSync("git", ["-C", repoPath, "status", "--porcelain"], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.status !== 0)
      throw new CapError(`Git status failed for ${repoPath}`, "GIT_ERROR");
    return result.stdout;
  }

  diff(repoPath: string, commit: string): string {
    const result = spawnSync(
      "git",
      ["-C", repoPath, "diff", "--no-ext-diff", "--binary", commit, "--"],
      {
        encoding: "utf8",
        windowsHide: true,
      },
    );
    if (result.status !== 0)
      throw new CapError(`Git diff failed for ${repoPath}`, "GIT_ERROR");
    return result.stdout;
  }

  untrackedFiles(repoPath: string): string[] {
    const result = spawnSync(
      "git",
      ["-C", repoPath, "ls-files", "--others", "--exclude-standard"],
      {
        encoding: "utf8",
        windowsHide: true,
      },
    );
    if (result.status !== 0)
      throw new CapError(
        `Git untracked-file check failed for ${repoPath}`,
        "GIT_ERROR",
      );
    return result.stdout.split(/\r?\n/).filter(Boolean);
  }

  addDetachedWorktree(
    repoPath: string,
    worktreePath: string,
    commit: string,
  ): void {
    const result = spawnSync(
      "git",
      ["-C", repoPath, "worktree", "add", "--detach", worktreePath, commit],
      {
        encoding: "utf8",
        windowsHide: true,
      },
    );
    if (result.status !== 0) {
      throw new CapError(
        `Git worktree creation failed: ${result.stderr.trim()}`,
        "WORKTREE_CREATE_FAILED",
      );
    }
  }

  removeWorktree(repoPath: string, worktreePath: string): void {
    const result = spawnSync(
      "git",
      ["-C", repoPath, "worktree", "remove", "--force", worktreePath],
      {
        encoding: "utf8",
        windowsHide: true,
      },
    );
    if (result.status !== 0) {
      throw new CapError(
        `Git worktree removal failed: ${result.stderr.trim()}`,
        "WORKTREE_REMOVE_FAILED",
      );
    }
  }

  resetHard(repoPath: string, commit: string): void {
    const result = spawnSync(
      "git",
      ["-C", repoPath, "reset", "--hard", commit],
      {
        encoding: "utf8",
        windowsHide: true,
      },
    );
    if (result.status !== 0)
      throw new CapError(`Git reset failed for ${repoPath}`, "GIT_ERROR");
  }

  cleanUntracked(repoPath: string): void {
    const gitArgs =
      process.platform === "win32"
        ? [
            "-c",
            "core.longpaths=true",
            "-C",
            repoPath,
            "clean",
            "-fd",
            "--",
            ".",
          ]
        : ["-C", repoPath, "clean", "-fd", "--", "."];
    const result = spawnSync("git", gitArgs, {
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.status !== 0)
      throw new CapError(`Git clean failed for ${repoPath}`, "GIT_ERROR");
  }

  pruneWorktrees(repoPath: string): void {
    const result = spawnSync("git", ["-C", repoPath, "worktree", "prune"], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.status !== 0)
      throw new CapError(
        `Git worktree prune failed for ${repoPath}`,
        "GIT_ERROR",
      );
  }

  version(): string {
    const result = spawnSync("git", ["--version"], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.status !== 0)
      throw new CapError("Git is not available", "GIT_UNAVAILABLE");
    return result.stdout.trim();
  }

  private runGit(
    repoPath: string,
    args: string[],
    message: string,
    code = "GIT_ERROR",
  ): string {
    const result = spawnSync("git", ["-C", repoPath, ...args], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.status !== 0)
      throw new CapError(`${message}: ${result.stderr.trim()}`, code);
    return result.stdout.trim();
  }
}
