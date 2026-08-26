import { spawnSync } from "node:child_process";
import { CapError } from "./errors.js";

export interface GitClient {
  resolveCommit(repoPath: string, commit: string): string;
  statusPorcelain(repoPath: string): string;
  version(): string;
}

export class CliGitClient implements GitClient {
  resolveCommit(repoPath: string, commit: string): string {
    const result = spawnSync(
      "git",
      ["-C", repoPath, "rev-parse", "--verify", `${commit}^{commit}`],
      {
        encoding: "utf8",
        windowsHide: true,
      },
    );
    if (result.status !== 0) {
      throw new CapError(
        `Git target commit could not be resolved: ${commit}`,
        "INVALID_TARGET_COMMIT",
      );
    }
    return result.stdout.trim();
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

  version(): string {
    const result = spawnSync("git", ["--version"], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.status !== 0)
      throw new CapError("Git is not available", "GIT_UNAVAILABLE");
    return result.stdout.trim();
  }
}
