import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AcceptanceHomePaths } from "./paths.js";
import type { Project } from "./domain.js";
import { SqliteStore } from "./storage.js";

export interface RetentionPolicy {
  version: 1;
  completed_pass_days: number;
  completed_fail_days: number;
  human_or_infra_days: number;
}

export const defaultRetentionPolicy: RetentionPolicy = {
  version: 1,
  completed_pass_days: 30,
  completed_fail_days: 90,
  human_or_infra_days: 180,
};

export interface RetentionItem {
  project_id: string;
  task_id: string;
  run_id: string;
  status: string;
  age_days: number;
  retention_days: number;
  artifact_root_exists: boolean;
  action: "RETAIN" | "ELIGIBLE";
}

export interface RetentionPlan {
  version: 1;
  generated_at: string;
  policy: RetentionPolicy;
  items: RetentionItem[];
}

export class RetentionManager {
  constructor(
    private readonly home: AcceptanceHomePaths,
    private readonly store: SqliteStore,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly policy: RetentionPolicy = defaultRetentionPolicy,
  ) {}

  plan(projects: Project[] = this.store.listProjects()): RetentionPlan {
    const now = Date.parse(this.now());
    const items = projects.flatMap((project) =>
      this.store.listRuns(project.id).map((run) => {
        const ageDays = Math.max(
          0,
          Math.floor((now - Date.parse(run.createdAt)) / 86_400_000),
        );
        const retentionDays = retentionDaysFor(run.status, this.policy);
        const artifactRoot = join(
          this.home.projects,
          project.id,
          "runs",
          run.taskId,
          run.id,
        );
        return {
          project_id: project.id,
          task_id: run.taskId,
          run_id: run.id,
          status: run.status,
          age_days: ageDays,
          retention_days: retentionDays,
          artifact_root_exists: existsSync(artifactRoot),
          action: ageDays >= retentionDays ? "ELIGIBLE" : "RETAIN",
        } satisfies RetentionItem;
      }),
    );
    return {
      version: 1,
      generated_at: this.now(),
      policy: this.policy,
      items,
    };
  }
}

function retentionDaysFor(status: string, policy: RetentionPolicy): number {
  if (status === "COMPLETED_PASS") return policy.completed_pass_days;
  if (status === "COMPLETED_FAIL") return policy.completed_fail_days;
  return policy.human_or_infra_days;
}
