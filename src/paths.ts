import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { mkdir } from "node:fs/promises";

export interface AcceptanceHomePaths {
  root: string;
  state: string;
  projects: string;
  worktrees: string;
  runtime: string;
  locks: string;
  trash: string;
  baselinesCache: string;
  logs: string;
}

export function resolveAcceptanceHome(explicit?: string): AcceptanceHomePaths {
  const root = resolve(
    explicit ??
      process.env.CAP_ACCEPTANCE_HOME ??
      join(homedir(), ".codex-acceptance"),
  );
  return {
    root,
    state: join(root, "state"),
    projects: join(root, "projects"),
    worktrees: join(root, "worktrees"),
    runtime: join(root, "runtime"),
    locks: join(root, "locks"),
    trash: join(root, "trash"),
    baselinesCache: join(root, "baselines-cache"),
    logs: join(root, "logs"),
  };
}

export async function ensureAcceptanceHome(
  paths: AcceptanceHomePaths,
): Promise<void> {
  await Promise.all([
    mkdir(paths.state, { recursive: true }),
    mkdir(paths.projects, { recursive: true }),
    mkdir(paths.worktrees, { recursive: true }),
    mkdir(paths.runtime, { recursive: true }),
    mkdir(paths.locks, { recursive: true }),
    mkdir(paths.trash, { recursive: true }),
    mkdir(paths.baselinesCache, { recursive: true }),
    mkdir(paths.logs, { recursive: true }),
  ]);
}

export function databasePath(paths: AcceptanceHomePaths): string {
  return join(paths.state, "acceptance.sqlite");
}
