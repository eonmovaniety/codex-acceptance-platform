import { readFileSync } from "node:fs";
import type {
  AcceptanceContract,
  AcceptanceRun,
  Project,
  ProjectConfig,
  Task,
} from "./domain.js";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { ArtifactStore } from "./artifacts.js";
import {
  loadAcceptanceContract,
  loadProjectConfig,
  loadVisualCase,
} from "./config.js";
import { AcceptanceController } from "./controller.js";
import { CapError } from "./errors.js";
import { EvidenceIndexBuilder } from "./evidence.js";
import { FailurePackageService, ImpactAnalyzer } from "./failure.js";
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
import { MultiReviewerEngine, type ReviewerRole } from "./multi-review.js";
import type { AcceptanceHomePaths } from "./paths.js";
import {
  CodexCliReviewerProvider,
  FakeReviewerProvider,
  ReviewerService,
  ReviewerSessionManager,
  type ReviewerProvider,
  type ReviewerReport,
} from "./review.js";
import { LocalCommandRunner, type CommandRunner } from "./runner.js";
import { SqliteStore, systemClock, type Clock } from "./storage.js";
import { transitionRun, transitionTask } from "./state-machine.js";
import { GenericCommandAdapter, type VerifierResult } from "./verifier.js";
import { CliGitClient, type GitClient } from "./git.js";
import { RuntimeManager, type RuntimeRecord } from "./runtime.js";
import { TestDataManager } from "./test-data.js";
import { validateDocument } from "./validation.js";
import {
  adversarialScenarios,
  assessRisk,
  defaultRiskPolicy,
  type RiskAssessment,
} from "./risk.js";
import {
  BaselineStore,
  DeterministicVisualAdapter,
  ScreenshotCaptureService,
  type VisualCaptureResult,
} from "./visual.js";
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
  visual: VisualCaptureResult;
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
    if (run.status !== "CREATED" && run.status !== "VALIDATING") {
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
    const runManifest = {
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
    };
    validateDocument("run-manifest", runManifest);
    this.artifacts.writeJson(
      project.id,
      task.id,
      run.id,
      "run/manifest.json",
      runManifest,
    );

    let worktree: WorktreeRecord | undefined;
    let runtime: RuntimeRecord | undefined;
    let verifierResults: VerifierResult[] = [];
    try {
      if (run.status === "CREATED")
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
      const testData = new TestDataManager().prepare({
        runId: run.id,
        runtimePath: runtime.path,
        config,
        runner: this.commandRunner,
        now: () => this.clock.now(),
      });
      validateDocument("test-data-manifest", testData);
      this.artifacts.writeJson(
        project.id,
        task.id,
        run.id,
        "test-data/manifest.json",
        testData,
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
      const visual = await this.runVisualChecks(project, task, run, config);
      const risk = this.runRiskChecks(project, task, run, config);
      const evidencePaths = [
        "verifier/summary.json",
        ...verifierResults.flatMap((result) =>
          result.evidence.map((entry) => entry.path),
        ),
        ...visual.screenshots.map((screenshot) => screenshot.artifact_path),
        ...(visual.audit_results.length > 0 ? ["visual/audit.json"] : []),
      ];
      run = this.updateRunStatus(run, "REVIEWING", "RunReviewing");
      const selectedProvider = provider ?? this.createProvider(config);
      const sessionManager = new ReviewerSessionManager(this.artifacts, () =>
        this.clock.now(),
      );
      const reviewContext = {
        runId: run.id,
        projectId: project.id,
        taskId: task.id,
        targetCommit: run.targetCommit,
        worktreePath: worktree.path,
        contract,
        requirements: contract.requirements,
        verifierResults,
        evidencePaths: [...new Set(evidencePaths)].sort(),
        priorFailurePaths: this.previousFailurePaths(project, task),
        now: () => this.clock.now(),
      };
      let reviewReport: ReviewerReport;
      let reviewerSessionId: string;
      let reviewerConflicts: string[] = [];
      const configuredRoles = reviewerRoles(config);
      if (configuredRoles.length > 0) {
        const multi = new MultiReviewerEngine(
          sessionManager,
          this.artifacts,
        ).run(
          reviewContext,
          configuredRoles.map((role) => ({
            role,
            provider: provider ?? this.createProvider(config),
          })),
        );
        reviewReport = multi.report;
        reviewerSessionId =
          multi.sessions[0]?.providerSessionId ?? multi.sessions[0]?.id ?? "";
        reviewerConflicts = multi.conflicts.map((conflict) => conflict.id);
        if (reviewerConflicts.length > 0)
          this.artifacts.writeJson(
            project.id,
            task.id,
            run.id,
            "reviewer/conflicts.json",
            multi.conflicts,
          );
      } else {
        const review = new ReviewerService(sessionManager).review(
          reviewContext,
          selectedProvider,
        );
        reviewReport = review.report;
        reviewerSessionId =
          review.session.providerSessionId ?? review.session.id;
      }
      run = this.updateRun(
        {
          ...run,
          reviewerThreadId: reviewerSessionId,
        },
        "ReviewerSessionBound",
      );
      const evidence = new EvidenceIndexBuilder().write({
        projectId: project.id,
        taskId: task.id,
        runId: run.id,
        artifacts: this.artifacts,
        verifierResults,
        reviewerReport: reviewReport,
      });
      run = this.updateRunStatus(run, "GATING", "RunGating");
      const matrix = buildAcceptanceMatrix(contract, reviewReport, evidence);
      writeAcceptanceMatrix(this.artifacts, project.id, task.id, matrix);
      const configuredPolicy = gatePolicy(config, project.configPath);
      const gate = decideGate({
        matrix,
        report: reviewReport,
        verifierResults,
        ...(configuredPolicy ? { policy: configuredPolicy } : {}),
        additionalFindings: visual.audit_findings,
        humanTriggers: [
          ...(config.human_gates ?? []),
          ...visual.human_triggers,
          ...risk.human_triggers,
          ...(reviewerConflicts.length > 0 ? ["REVIEWER_CONFLICT"] : []),
        ],
        now: () => this.clock.now(),
      });
      writeGateDecision(this.artifacts, project.id, task.id, gate);
      run = this.completeRun(run, gate.decision);
      const finalTask = this.completeTask(task, gate.decision);
      this.dependencies.store.appendEvent(run.id, "GateDecided", {
        decision: gate.decision,
        reason_codes: gate.reason_codes,
      });
      if (gate.decision === "FAIL") {
        const failure = new FailurePackageService(this.artifacts, () =>
          this.clock.now(),
        ).create({
          run,
          task: finalTask,
          contract,
          matrix,
          report: reviewReport,
          gate,
        });
        const dirty = this.worktrees.captureDirtyState(worktree);
        const impact = new ImpactAnalyzer().analyze({
          runId: run.id,
          patch: dirty.patch,
          contract,
          failurePackage: failure.failurePackage,
        });
        this.artifacts.writeJson(
          project.id,
          task.id,
          run.id,
          "failure/impact-analysis.json",
          impact,
        );
        this.dependencies.store.appendEvent(run.id, "FailurePackageCreated", {
          failure_package_path: "failure/failure-package.json",
          fix_request_path: "failure/fix-request.json",
          escalation_level: failure.fixRequest.escalation_level,
        });
      }
      this.captureAndResetReviewerWorktree(worktree, project, task, run);
      this.artifacts.finalize(project.id, task.id, run.id);
      this.dependencies.store.appendEvent(run.id, "ArtifactsFinalized", {});
      return { run, task: finalTask, verifierResults, visual, matrix, gate };
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

  private async runVisualChecks(
    project: Project,
    task: Task,
    run: AcceptanceRun,
    config: ProjectConfig,
  ): Promise<VisualCaptureResult> {
    const visualConfig = config.visual;
    if (!visualConfig?.enabled || !visualConfig.cases?.length)
      return {
        screenshots: [],
        human_triggers: [],
        baseline_requests: [],
        audit_results: [],
        audit_findings: [],
      };
    const visualCases = await Promise.all(
      visualConfig.cases.map((path) =>
        loadVisualCase(resolve(dirname(project.configPath), path)),
      ),
    );
    const baselineStore =
      visualConfig.baseline === false
        ? undefined
        : new BaselineStore(this.dependencies.home, () => this.clock.now());
    const capture = new ScreenshotCaptureService(this.artifacts);
    const adapter = new DeterministicVisualAdapter(
      visualConfig.platform ?? "web",
    );
    const captures = visualCases.map((visualCase) =>
      capture.captureCase({
        projectId: project.id,
        taskId: task.id,
        runId: run.id,
        testDataVersion: run.testDataVersion,
        visualCase,
        adapter,
        ...(baselineStore ? { baselineStore } : {}),
      }),
    );
    const result: VisualCaptureResult = {
      screenshots: captures.flatMap(
        (captureResult) => captureResult.screenshots,
      ),
      human_triggers: [
        ...new Set(
          captures.flatMap((captureResult) => captureResult.human_triggers),
        ),
      ].sort(),
      baseline_requests: captures.flatMap(
        (captureResult) => captureResult.baseline_requests,
      ),
      audit_results: captures.flatMap(
        (captureResult) => captureResult.audit_results,
      ),
      audit_findings: captures.flatMap(
        (captureResult) => captureResult.audit_findings,
      ),
    };
    validateDocument("visual-capture-result", result);
    this.artifacts.writeJson(
      project.id,
      task.id,
      run.id,
      "visual/summary.json",
      result,
    );
    if (result.baseline_requests.length > 0)
      this.artifacts.writeJson(
        project.id,
        task.id,
        run.id,
        "visual/baseline-requests.json",
        result.baseline_requests,
      );
    if (result.audit_results.length > 0)
      this.artifacts.writeJson(
        project.id,
        task.id,
        run.id,
        "visual/audit.json",
        {
          version: 1,
          results: result.audit_results,
          findings: result.audit_findings,
        },
      );
    return result;
  }

  private runRiskChecks(
    project: Project,
    task: Task,
    run: AcceptanceRun,
    config: ProjectConfig,
  ): RiskAssessment {
    const policy = {
      ...defaultRiskPolicy,
      sampling_percent: config.risk?.sampling_percent ?? 0,
    };
    const assessment = assessRisk({
      riskLevel: task.riskLevel,
      runId: run.id,
      policy,
      ...(config.risk?.security_sensitive ? { securitySensitive: true } : {}),
      ...(config.risk?.release_requested ? { releaseRequested: true } : {}),
    });
    validateDocument("risk-assessment", assessment);
    this.artifacts.writeJson(
      project.id,
      task.id,
      run.id,
      "risk/assessment.json",
      assessment,
    );
    this.artifacts.writeJson(
      project.id,
      task.id,
      run.id,
      "risk/adversarial-scenarios.json",
      adversarialScenarios(task.riskLevel),
    );
    return assessment;
  }

  private previousFailurePaths(project: Project, task: Task): string[] {
    return this.dependencies.store
      .listRuns(project.id, task.id)
      .filter((candidate) => candidate.status === "COMPLETED_FAIL")
      .map((candidate) =>
        this.artifacts.exists(
          project.id,
          task.id,
          candidate.id,
          "failure/failure-package.json",
        )
          ? `runs/${task.id}/${candidate.id}/failure/failure-package.json`
          : undefined,
      )
      .filter((path): path is string => path !== undefined)
      .sort();
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
      ...(status === "VALIDATING" && !run.startedAt
        ? { startedAt: this.clock.now() }
        : {}),
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

function gatePolicy(
  config: ProjectConfig,
  projectConfigPath: string,
): GatePolicy | undefined {
  if (!config.gate?.policy) return undefined;
  try {
    return validateDocument<GatePolicy>(
      "gate-policy",
      parseYaml(
        readFileSync(
          resolve(dirname(projectConfigPath), config.gate.policy),
          "utf8",
        ),
      ),
    );
  } catch (error) {
    throw new CapError(
      `Gate policy could not be loaded: ${config.gate.policy}: ${error instanceof Error ? error.message : String(error)}`,
      "GATE_POLICY_INVALID",
    );
  }
}

function reviewerRoles(config: ProjectConfig): ReviewerRole[] {
  const values = config.reviewer?.roles ?? [];
  const allowed: ReviewerRole[] = [
    "functional",
    "visual",
    "security",
    "architecture",
    "test-gap",
  ];
  for (const value of values) {
    if (!allowed.includes(value as ReviewerRole))
      throw new CapError(
        `Unknown reviewer role '${value}'`,
        "REVIEWER_ROLE_INVALID",
      );
  }
  return values as ReviewerRole[];
}
