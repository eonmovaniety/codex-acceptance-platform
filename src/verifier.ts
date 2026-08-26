import type { ProjectConfig } from "./domain.js";
import type { ArtifactStore } from "./artifacts.js";
import type { CommandResult, CommandRunner } from "./runner.js";
import { CapError } from "./errors.js";
import { validateDocument } from "./validation.js";

export type VerifierResultValue = "PASS" | "FAIL" | "BLOCKED" | "NOT_TESTED";
export type VerifierStage =
  "setup" | "build" | "lint" | "unit" | "integration" | "e2e";

export interface VerifierEvidence {
  kind: "test-report" | "log" | "command-result" | "target-integrity";
  path: string;
  level?: "E1" | "E2" | "E3" | "E4" | "E5";
}

export interface VerifierResult {
  version: 1;
  run_id: string;
  verifier: string;
  stage: VerifierStage;
  result: VerifierResultValue;
  started_at: string;
  completed_at: string;
  command?: string;
  exit_code: number | null;
  evidence: VerifierEvidence[];
  warnings: string[];
}

export interface VerifierContext {
  runId: string;
  projectId: string;
  taskId: string;
  targetCommit: string;
  worktreePath: string;
  config: ProjectConfig;
  artifacts: ArtifactStore;
  runner: CommandRunner;
  assertTarget: () => void;
  now?: () => string;
  timeoutMs?: number;
}

export interface GenericVerifierOptions {
  stages?: VerifierStage[];
  stopOnFailure?: boolean;
}

const defaultStages: VerifierStage[] = [
  "setup",
  "build",
  "lint",
  "unit",
  "integration",
  "e2e",
];

export class GenericCommandAdapter {
  constructor(private readonly options: GenericVerifierOptions = {}) {}

  run(context: VerifierContext): VerifierResult[] {
    const stages = this.options.stages ?? defaultStages;
    const results: VerifierResult[] = [];
    let halted = false;
    for (const stage of stages) {
      const commands = context.config.commands?.[stage] ?? [];
      if (halted || commands.length === 0) {
        results.push(
          validateDocument<VerifierResult>(
            "verifier-result",
            this.notTested(
              context,
              stage,
              halted
                ? "Skipped after a previous verifier failure"
                : "No command configured",
            ),
          ),
        );
        continue;
      }
      for (let index = 0; index < commands.length; index += 1) {
        const command = commands[index];
        if (!command) continue;
        context.assertTarget();
        const startedAt = now(context);
        const result = context.runner.run(command, {
          cwd: context.worktreePath,
          timeoutMs:
            context.timeoutMs ??
            (context.config.runtime?.timeout_seconds ?? 300) * 1000,
          env: {
            CAP_ACCEPTANCE_RUN_ID: context.runId,
            CAP_PROJECT_ID: context.projectId,
            CAP_TASK_ID: context.taskId,
            CAP_TARGET_COMMIT: context.targetCommit,
          },
        });
        context.assertTarget();
        const base = `verifier/${stage}/${String(index + 1).padStart(2, "0")}`;
        const stdoutPath = context.artifacts.writeText(
          context.projectId,
          context.taskId,
          context.runId,
          `${base}.stdout.log`,
          result.stdout,
        );
        const stderrPath = context.artifacts.writeText(
          context.projectId,
          context.taskId,
          context.runId,
          `${base}.stderr.log`,
          result.stderr,
        );
        const relativeStdout = relativeArtifact(context, stdoutPath);
        const relativeStderr = relativeArtifact(context, stderrPath);
        const relativeResult = `${base}.result.json`;
        const verifierResult = validateDocument<VerifierResult>(
          "verifier-result",
          this.toResult(context, stage, startedAt, command, result, [
            { kind: "log", path: relativeStdout, level: "E2" },
            { kind: "log", path: relativeStderr, level: "E2" },
            { kind: "command-result", path: relativeResult, level: "E2" },
          ]),
        );
        context.artifacts.writeJson(
          context.projectId,
          context.taskId,
          context.runId,
          relativeResult,
          verifierResult,
        );
        results.push(verifierResult);
        if (
          verifierResult.result !== "PASS" &&
          (this.options.stopOnFailure ?? true)
        ) {
          halted = true;
          break;
        }
      }
    }
    const summary = aggregateVerifierResults(results);
    context.artifacts.writeJson(
      context.projectId,
      context.taskId,
      context.runId,
      "verifier/summary.json",
      {
        version: 1,
        run_id: context.runId,
        result: summary,
        stages: results,
      },
    );
    return results;
  }

  private toResult(
    context: VerifierContext,
    stage: VerifierStage,
    startedAt: string,
    command: string,
    result: CommandResult,
    evidence: VerifierEvidence[],
  ): VerifierResult {
    const value: VerifierResultValue = result.timedOut
      ? "BLOCKED"
      : result.exitCode === 0
        ? "PASS"
        : "FAIL";
    return {
      version: 1,
      run_id: context.runId,
      verifier: "generic-command",
      stage,
      result: value,
      started_at: startedAt,
      completed_at: now(context),
      command,
      exit_code: result.exitCode,
      evidence,
      warnings: result.timedOut
        ? ["Command timed out"]
        : result.stderr && value === "PASS"
          ? ["Command wrote to stderr"]
          : [],
    };
  }

  private notTested(
    context: VerifierContext,
    stage: VerifierStage,
    warning: string,
  ): VerifierResult {
    return {
      version: 1,
      run_id: context.runId,
      verifier: "generic-command",
      stage,
      result: "NOT_TESTED",
      started_at: now(context),
      completed_at: now(context),
      exit_code: null,
      evidence: [],
      warnings: [warning],
    };
  }
}

export function aggregateVerifierResults(
  results: VerifierResult[],
): VerifierResultValue {
  if (results.some((result) => result.result === "BLOCKED")) return "BLOCKED";
  if (results.some((result) => result.result === "FAIL")) return "FAIL";
  if (
    results.length === 0 ||
    results.every((result) => result.result === "NOT_TESTED")
  )
    return "NOT_TESTED";
  return "PASS";
}

function now(context: VerifierContext): string {
  return context.now?.() ?? new Date().toISOString();
}

function relativeArtifact(context: VerifierContext, path: string): string {
  const marker = `/runs/${context.taskId}/${context.runId}/`;
  const normalized = path.replaceAll("\\", "/");
  const index = normalized.indexOf(marker);
  if (index < 0)
    throw new CapError(
      `Verifier artifact is outside the expected run: ${path}`,
      "ARTIFACT_PATH_INVALID",
    );
  return normalized.slice(index + marker.length);
}
