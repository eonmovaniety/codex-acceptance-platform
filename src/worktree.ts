import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import type { GitClient } from "./git.js";
import { CapError } from "./errors.js";
import type { AcceptanceHomePaths } from "./paths.js";

const markerName = ".cap-worktree.json";

export interface WorktreeRecord {
  runId: string;
  projectId: string;
  repoPath: string;
  path: string;
  targetCommit: string;
  markerPath: string;
  state: "CREATED" | "DIRTY_CAPTURED" | "RESET" | "REMOVED";
}

export interface DirtyWorktreeState {
  head: string;
  targetCommit: string;
  dirty: boolean;
  status: string;
  patch: string;
  untrackedFiles: string[];
}

function assertContained(root: string, candidate: string): void {
  const normalizedRoot = resolve(root);
  const normalizedCandidate = resolve(candidate);
  const relativePath = relative(normalizedRoot, normalizedCandidate);
  if (
    relativePath === "" ||
    relativePath.startsWith("..") ||
    relativePath.startsWith("\\") ||
    relativePath.startsWith("/")
  ) {
    throw new CapError(
      `Managed path is outside CAP root: ${candidate}`,
      "PATH_OUTSIDE_MANAGED_ROOT",
    );
  }
}

export class WorktreeManager {
  constructor(
    private readonly home: AcceptanceHomePaths,
    private readonly git: GitClient,
  ) {}

  create(
    projectId: string,
    runId: string,
    repoPath: string,
    requestedCommit: string,
  ): WorktreeRecord {
    const targetCommit = this.git.resolveCommit(repoPath, requestedCommit);
    const projectRoot = join(this.home.worktrees, projectId);
    const worktreePath = join(projectRoot, runId);
    const markerPath = join(projectRoot, `${runId}.marker.json`);
    assertContained(this.home.worktrees, worktreePath);
    assertContained(this.home.worktrees, markerPath);
    if (existsSync(worktreePath) || existsSync(markerPath)) {
      throw new CapError(
        `Managed worktree already exists for ${runId}`,
        "WORKTREE_EXISTS",
      );
    }
    mkdirSync(projectRoot, { recursive: true });
    this.git.addDetachedWorktree(repoPath, worktreePath, targetCommit);
    try {
      this.assertTarget(worktreePath, targetCommit);
      const record: WorktreeRecord = {
        runId,
        projectId,
        repoPath: resolve(repoPath),
        path: worktreePath,
        targetCommit,
        markerPath,
        state: "CREATED",
      };
      writeFileSync(
        markerPath,
        `${JSON.stringify({ marker: markerName, ...record }, null, 2)}\n`,
        "utf8",
      );
      return record;
    } catch (error) {
      try {
        this.git.removeWorktree(repoPath, worktreePath);
      } catch {
        // Preserve the original failure. The doctor/cleanup pass can repair an orphan.
      }
      throw error;
    }
  }

  assertTarget(worktreePath: string, targetCommit: string): void {
    const head = this.git.resolveCommit(worktreePath, "HEAD");
    if (head !== targetCommit) {
      throw new CapError(
        `Worktree HEAD drifted: expected ${targetCommit}, got ${head}`,
        "TARGET_SHA_DRIFT",
      );
    }
  }

  captureDirtyState(record: WorktreeRecord): DirtyWorktreeState {
    this.assertMarker(record);
    this.assertTarget(record.path, record.targetCommit);
    const status = this.git.statusPorcelain(record.path);
    const patch = this.git.diff(record.path, record.targetCommit);
    const untrackedFiles = this.git.untrackedFiles(record.path);
    return {
      head: record.targetCommit,
      targetCommit: record.targetCommit,
      dirty: status.length > 0,
      status,
      patch,
      untrackedFiles,
    };
  }

  resetToTarget(record: WorktreeRecord): WorktreeRecord {
    this.assertMarker(record);
    this.git.resetHard(record.path, record.targetCommit);
    this.git.cleanUntracked(record.path);
    this.assertTarget(record.path, record.targetCommit);
    const reset = { ...record, state: "RESET" as const };
    writeFileSync(
      record.markerPath,
      `${JSON.stringify({ marker: markerName, ...reset }, null, 2)}\n`,
      "utf8",
    );
    return reset;
  }

  remove(record: WorktreeRecord): void {
    this.assertMarker(record);
    assertContained(this.home.worktrees, record.path);
    assertContained(this.home.worktrees, record.markerPath);
    this.git.removeWorktree(record.repoPath, record.path);
    this.git.pruneWorktrees(record.repoPath);
    if (existsSync(record.path))
      rmSync(record.path, { recursive: true, force: true });
    if (existsSync(record.markerPath))
      rmSync(record.markerPath, { force: true });
  }

  readMarker(markerPath: string): WorktreeRecord {
    assertContained(this.home.worktrees, markerPath);
    const value = JSON.parse(readFileSync(markerPath, "utf8")) as {
      marker?: string;
    } & WorktreeRecord;
    if (value.marker !== markerName)
      throw new CapError(
        `Invalid CAP worktree marker: ${markerPath}`,
        "INVALID_MARKER",
      );
    return value;
  }

  private assertMarker(record: WorktreeRecord): void {
    const marker = this.readMarker(record.markerPath);
    if (
      marker.runId !== record.runId ||
      marker.projectId !== record.projectId ||
      resolve(marker.path) !== resolve(record.path) ||
      marker.targetCommit !== record.targetCommit
    ) {
      throw new CapError(
        `Worktree marker does not match run ${record.runId}`,
        "MARKER_MISMATCH",
      );
    }
  }
}
