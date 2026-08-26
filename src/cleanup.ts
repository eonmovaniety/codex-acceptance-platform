import { existsSync } from "node:fs";
import type { RuntimeRecord } from "./runtime.js";
import { RuntimeManager } from "./runtime.js";
import type { WorktreeRecord } from "./worktree.js";
import { WorktreeManager } from "./worktree.js";

export class CleanupManager {
  constructor(
    private readonly worktrees: WorktreeManager,
    private readonly runtimes: RuntimeManager,
  ) {}

  cleanupRun(resources: {
    worktree?: WorktreeRecord;
    runtime?: RuntimeRecord;
  }): void {
    if (resources.worktree && existsSync(resources.worktree.markerPath))
      this.worktrees.remove(resources.worktree);
    if (resources.runtime && existsSync(resources.runtime.markerPath))
      this.runtimes.release(resources.runtime);
  }
}
