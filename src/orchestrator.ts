import { readFileSync } from "node:fs";
import type {
  AcceptanceContract,
  AcceptanceRun,
  Project,
  ProjectConfig,
  Task,
} from "./domain.js";
import { ArtifactStore } from "./artifacts.js";
import { loadAcceptanceContract, loadProjectConfig } from "./config.js";
import { AcceptanceController } from "./controller.js";
import { CapError } from "./errors.js";
import { EvidenceIndexBuilder } from "./evidence.js";
import {
  decideGate,
  writeGateDecision,
  type GateDecision,
  type GatePolicy,
} from "./gate.js";
import {
  buildAcceptanceMatrix,
  writeAcceptanceMatrix,
  type AcceptanceMatrix,
} from "./matrix.js";
import type { AcceptanceHomePaths } from "./paths.js";
import {
  CodexCliReviewerProvider,
  FakeReviewerProvider,
  ReviewerService,
  ReviewerSessionManager,
  type ReviewerProvider,
} from "./review.js";
import { LocalCommandRunner, type CommandRunner } from "./runner.js";
import { SqliteStore, systemClock, type Clock } from "./storage.js";
import { transitionRun, transitionTask } from "./state-machine.js";
import { GenericCommandAdapter, type VerifierResult } from "./verifier.js";
import { CliGitClient, type GitClient } from "./git.js";
import { RuntimeManager, type RuntimeRecord } from "./runtime.js";
import { WorktreeManager, type WorktreeRecord } from "./worktree.js";

export interface AcceptanceRunExecutorDependencies {
  store: SqliteStore;
  home: AcceptanceHomePaths;
  git?: GitClient;
  clock?: Clock;
  commandRunner?: CommandRunner;
  reviewerProviderFactory?: (input: {
    config: ProjectConfig;
    schemaPath: string;
  }) => ReviewerProvider;
  reviewerSchemaPath?: string;
}

export interface RunExecutionResult {
  run: AcceptanceRun;
  task: Task;
  verifierResults: VerifierResult[];
  matrix: AcceptanceMatrix;
  gate: GateDecision;
}

export class AcceptanceRunExecutor {
  private readonly git: GitClient;
  private readonly clock: Clock;
  private readonly commandRunner: CommandRunner;
  private readonly artifacts: ArtifactStore;
  private readonly worktrees: WorktreeManager;
  private readonly runtimes: RuntimeManager;
  private readonly reviewerSchemaPath: string;

  constructor(
    private readonly dependencies: AcceptanceRunExecutorDependencies,
  ) {
    this.git = dependencies.git ?? new CliGitClient();
    this.clock = dependencies.clock ?? systemClock;
    this.commandRunner = dependencies.commandRunner ?? new LocalCommandRunner();
    this.artifacts = new ArtifactStore(dependencies.home, () =>
      this.clock.now(),
    );
    this.worktrees = new WorktreeManager(dependencies.home, this.git);
    this.runtimes = new RuntimeManager(
      dependencies.home,
      dependencies.store,
      this.clock,
    );
    this.reviewerSchemaPath =
      dependencies.reviewerSchemaPath ?? "schemas/reviewer-report.schema.json";
  }

  async execute(
    runId: string,
    provider?: ReviewerProvider,
  ): Promise<RunExecutionResult> {
    let run = this.dependencies.store.getRun(runId);
    if (run.status !== "CREATED") {
      throw new CapError(
        `Run '${runId}' is not executable from status ${run.status}`,
        "RUN_NOT_EXECUTABLE",
      );
    }
    const project = this.dependencies.store.getProject(run.projectId);
    const task = this.dependencies.store.getTask(run.projectId, run.taskId);
    const contractRecord = this.dependencies.store.findContract(
      run.projectId,
      run.taskId,
      run.contractVersion,
    );
    if (!contractRecord)
      throw new CapError(
        `Contract ${run.contractVersion} is missing for ${run.id}`,
        "CONTRACT_NOT_FOUND",
      );
    const [config, contract] = await Promise.all([
      loadProjectConfig(project.configPath),
      loadAcceptanceContract(contractRecord.path),
    ]);
    if (contract.task_id !== task.id)
      throw new CapError(
        `Contract task_id does not match task ${task.id}`,
        "CONTRACT_TASK_MISMATCH",
      );
    this.artifacts.ensureRun(project.id, task.id, run.id);
    this.artifacts.writeJson(project.id, task.id, run.id, "run/manifest.json", {
      version: 1,
      run_id: run.id,
      project_id: project.id,
      task_id: task.id,
      target_commit: run.targetCommit,
      contract_version: run.contractVersion,
      test_data_version: run.testDataVersion,
      gate_policy_version: run.gatePolicyVersion,
      created_at: run.createdAt,
      immutable: true,
    });

    let worktree: WorktreeRecord | undefined;
    let runtime: RuntimeRecord | undefined;
    let verifierResults: VerifierResult[] = [];
    try {
      run = this.updateRunStatus(run, "VALIDATING", "RunValidating");
      worktree = this.worktrees.create(
        project.id,
        run.id,
        project.repoPath,
        run.targetCommit,
      );
      runtime = this.runtimes.allocate(project.id, task.id, run.id);
      this.artifacts.writeJson(
        project.id,
        task.id,
        run.id,
        "runtime/record.json",
        runtime,
      );
      run = this.updateRunStatus(run, "PREPARING", "RunPreparing");
      run = this.updateRunStatus(run, "VERIFYING", "RunVerifying");
      const verifier = new GenericCommandAdapter();
      verifierResults = verifier.run({
        runId: run.id,
        projectId: project.id,
        taskId: task.id,
        targetCommit: run.targetCommit,
        worktreePath: worktree.path,
        config,
        artifacts: this.artifacts,
        runner: this.commandRunner,
        assertTarget: () =>
          this.worktrees.assertTarget(worktree!.path, run.targetCommit),
        now: () => this.clock.now(),
      });
      const evidencePaths = [
        "verifier/summary.json",
        ...verifierResults.flatMap((result) =>
          result.evidence.map((entry) => entry.path),
        ),
      ];
      run = this.updateRunStatus(run, "REVIEWING", "RunReviewing");
      const selectedProvider = provider ?? this.createProvider(config);
      const sessionManager = new ReviewerSessionManager(this.artifacts, () =>
        this.clock.now(),
      );
      const review = new ReviewerService(sessionManager).review(
        {
          runId: run.id,
          projectId: project.id,
          taskId: task.id,
          targetCommit: run.targetCommit,
          worktreePath: worktree.path,
          contract,
          requirements: contract.requirements,
          verifierResults,
          evidencePaths: [...new Set(evidencePaths)].sort(),
          now: () => this.clock.now(),
        },
        selectedProvider,
      );
      if (review.session.providerSessionId) {
        run = this.updateRun(
          { ...run, reviewerThreadId: review.session.providerSessionId },
          "ReviewerSessionBound",
        );
      }
      const evidence = new EvidenceIndexBuilder().write({
        projectId: project.id,
        taskId: task.id,
        runId: run.id,
        artifacts: this.artifacts,
        verifierResults,
        reviewerReport: review.report,
      });
      run = this.updateRunStatus(run, "GATING", "RunGating");
      const matrix = buildAcceptanceMatrix(contract, review.report, evidence);
      writeAcceptanceMatrix(this.artifacts, project.id, task.id, matrix);
      const configuredPolicy = gatePolicy(config);
      const gate = decideGate({
        matrix,
        report: review.report,
        verifierResults,
        ...(configuredPolicy ? { policy: configuredPolicy } : {}),
        humanTriggers: config.human_gates ?? [],
        now: () => this.clock.now(),
      });
      writeGateDecision(this.artifacts, project.id, task.id, gate);
      run = this.completeRun(run, gate.decision);
      const finalTask = this.completeTask(task, gate.decision);
      this.dependencies.store.appendEvent(run.id, "GateDecided", {
        decision: gate.decision,
        reason_codes: gate.reason_codes,
      });
      this.captureAndResetReviewerWorktree(worktree, project, task, run);
      this.artifacts.finalize(project.id, task.id, run.id);
      this.dependencies.store.appendEvent(run.id, "ArtifactsFinalized", {});
      return { run, task: finalTask, verifierResults, matrix, gate };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.artifacts.writeJson(project.id, task.id, run.id, "run/error.json", {
        version: 1,
        run_id: run.id,
        error: message,
      });
      if (
        ["VALIDATING", "PREPARING", "VERIFYING", "REVIEWING"].includes(
          run.status,
        )
      ) {
        run = this.updateRunStatus(
          run,
          "INFRA_FAILED",
          "RunInfrastructureFailed",
          {
            error: message,
          },
        );
      }
      if (worktree) {
        try {
          this.captureAndResetReviewerWorktree(worktree, project, task, run);
        } catch {
          // The original failure is retained in run/error.json.
        }
      }
      if (runtime) {
        try {
          this.runtimes.release(runtime);
        } catch {
          // The marker and lease remain discoverable by cleanup/doctor.
        }
      }
      try {
        this.artifacts.finalize(project.id, task.id, run.id);
      } catch {
        // Preserve the original execution error.
      }
      throw error;
    } finally {
      if (runtime) {
        try {
          this.runtimes.release(runtime);
        } catch {
          // A failed cleanup is represented by the retained runtime marker.
        }
      }
      if (worktree) {
        try {
          if (this.git.statusPorcelain(worktree.path).trim())
            this.worktrees.resetToTarget(worktree);
          this.worktrees.remove(worktree);
        } catch {
          // The worktree marker remains for a safe explicit cleanup pass.
        }
      }
    }
  }

  private createProvider(config: ProjectConfig): ReviewerProvider {
    if (this.dependencies.reviewerProviderFactory)
      return this.dependencies.reviewerProviderFactory({
        config,
        schemaPath: this.reviewerSchemaPath,
      });
    if (config.reviewer?.provider === "codex") {
      return new CodexCliReviewerProvider({
        schemaPath: this.reviewerSchemaPath,
      });
    }
    return new FakeReviewerProvider();
  }

  private updateRunStatus(
    run: AcceptanceRun,
    status: AcceptanceRun["status"],
    eventType: string,
    payload: Record<string, unknown> = {},
  ): AcceptanceRun {
    const nextStatus = transitionRun(run.status, status);
    const next = this.dependencies.store.updateRun({
      ...run,
      status: nextStatus,
    });
    this.dependencies.store.appendEvent(run.id, eventType, payload);
    return next;
  }

  private updateRun(run: AcceptanceRun, eventType: string): AcceptanceRun {
    const next = this.dependencies.store.updateRun(run);
    this.dependencies.store.appendEvent(run.id, eventType, {});
    return next;
  }

  private completeRun(
    run: AcceptanceRun,
    decision: AcceptanceRun["decision"],
  ): AcceptanceRun {
    if (!decision)
      throw new CapError("Gate decision is required", "GATE_DECISION_MISSING");
    const status =
      decision === "PASS"
        ? "COMPLETED_PASS"
        : decision === "FAIL"
          ? "COMPLETED_FAIL"
          : "COMPLETED_HUMAN";
    return this.dependencies.store.updateRun({
      ...run,
      status,
      decision,
      completedAt: this.clock.now(),
    });
  }

  private completeTask(task: Task, decision: AcceptanceRun["decision"]): Task {
    if (!decision)
      throw new CapError("Gate decision is required", "GATE_DECISION_MISSING");
    const nextStatus =
      decision === "PASS"
        ? transitionTask(task.status, "ACCEPTED")
        : decision === "FAIL"
          ? transitionTask(task.status, "FIX_REQUESTED")
          : transitionTask(task.status, "NEEDS_HUMAN");
    const next = {
      ...task,
      status: nextStatus,
      ...(decision === "PASS"
        ? { acceptedCommit: task.lastSubmittedCommit }
        : {}),
      ...(decision === "FAIL" ? { failureCount: task.failureCount + 1 } : {}),
      updatedAt: this.clock.now(),
    };
    return this.dependencies.store.updateTask(next);
  }

  private captureAndResetReviewerWorktree(
    worktree: WorktreeRecord,
    project: Project,
    task: Task,
    run: AcceptanceRun,
  ): void {
    const dirty = this.worktrees.captureDirtyState(worktree);
    this.artifacts.writeJson(
      project.id,
      task.id,
      run.id,
      "reviewer/dirty-state.json",
      dirty,
    );
    if (dirty.dirty) this.worktrees.resetToTarget(worktree);
  }
}

function gatePolicy(config: ProjectConfig): GatePolicy | undefined {
  if (!config.gate?.policy) return undefined;
  try {
    return JSON.parse(readFileSync(config.gate.policy, "utf8")) as GatePolicy;
  } catch (error) {
    throw new CapError(
      `Gate policy could not be loaded: ${config.gate.policy}: ${error instanceof Error ? error.message : String(error)}`,
      "GATE_POLICY_INVALID",
    );
  }
}
