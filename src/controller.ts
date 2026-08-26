import { dirname, resolve } from "node:path";
import type {
  AcceptanceContract,
  AcceptanceRun,
  ContractRecord,
  Project,
  ProjectConfig,
  RequirementRecord,
  SubmitResult,
  Task,
} from "./domain.js";
import { CapError, NotFoundError } from "./errors.js";
import { createIdempotencyKey, createRunId } from "./ids.js";
import { transitionTask } from "./state-machine.js";
import { SqliteStore, systemClock, type Clock } from "./storage.js";
import { sha256FileSync } from "./config.js";
import type { GitClient } from "./git.js";

export interface ControllerDependencies {
  store: SqliteStore;
  git: GitClient;
  clock?: Clock;
}

export class AcceptanceController {
  private readonly clock: Clock;

  constructor(private readonly dependencies: ControllerDependencies) {
    this.clock = dependencies.clock ?? systemClock;
  }

  registerProject(config: ProjectConfig, configPath: string): Project {
    const repoPath = resolve(dirname(dirname(configPath)));
    const existing = this.dependencies.store.findProject(config.project_id);
    if (existing) {
      if (resolve(existing.repoPath) !== repoPath) {
        throw new CapError(
          `Project '${config.project_id}' is already registered at ${existing.repoPath}`,
          "PROJECT_EXISTS",
        );
      }
      return existing;
    }
    const now = this.clock.now();
    const project: Project = {
      id: config.project_id,
      name: config.display_name,
      repoPath,
      baseBranch: config.repository.base_branch,
      configPath: resolve(configPath),
      status: "ACTIVE",
      createdAt: now,
      updatedAt: now,
    };
    return this.dependencies.store.createProject(project);
  }

  ensureTask(project: Project, contract: AcceptanceContract): Task {
    const existing = this.dependencies.store.findTask(
      project.id,
      contract.task_id,
    );
    const riskLevel = contract.risk_level ?? "R1";
    if (existing) {
      if (existing.title !== contract.title && existing.status !== "BUILDING") {
        throw new CapError(
          `Task '${contract.task_id}' title differs from the registered task`,
          "TASK_CONFLICT",
        );
      }
      return existing;
    }
    const now = this.clock.now();
    return this.dependencies.store.createTask({
      id: contract.task_id,
      projectId: project.id,
      title: contract.title,
      status: "BUILDING",
      riskLevel,
      failureCount: 0,
      createdAt: now,
      updatedAt: now,
    });
  }

  submit(
    project: Project,
    config: ProjectConfig,
    contract: AcceptanceContract,
    contractPath: string,
    requestedCommit: string,
  ): SubmitResult {
    if (contract.task_id.length === 0)
      throw new CapError("Contract task_id is required", "CONTRACT_INVALID");
    const targetCommit = this.dependencies.git.resolveCommit(
      project.repoPath,
      requestedCommit,
    );
    if (
      config.repository.require_clean_submission &&
      this.dependencies.git.statusPorcelain(project.repoPath).trim()
    ) {
      throw new CapError(
        "Submission requires a clean target repository",
        "DIRTY_SUBMISSION",
      );
    }

    return this.dependencies.store.withTransaction(() => {
      const task = this.ensureTask(project, contract);
      const contractHash = sha256FileSync(contractPath);
      const idempotencyKey = createIdempotencyKey(
        project.id,
        task.id,
        targetCommit,
        contractHash,
      );
      const existingRun =
        this.dependencies.store.findRunByIdempotencyKey(idempotencyKey);
      if (existingRun) return { run: existingRun, existing: true };

      const currentContract = this.dependencies.store.findContract(
        project.id,
        task.id,
        String(contract.version),
      );
      if (currentContract && currentContract.contentHash !== contractHash) {
        throw new CapError(
          `Contract version ${contract.version} already exists with different content; use a new version`,
          "CONTRACT_VERSION_CONFLICT",
        );
      }
      const contractRecord =
        currentContract ??
        this.createContract(
          project,
          task,
          contract,
          contractPath,
          contractHash,
        );
      if (
        task.status === "BUILDING" ||
        task.status === "FIXING" ||
        task.status === "BLOCKED"
      ) {
        task.status = transitionTask(task.status, "READY_FOR_REVIEW");
      }
      if (task.status !== "READY_FOR_REVIEW") {
        throw new CapError(
          `Task '${task.id}' is not ready for a new acceptance run: ${task.status}`,
          "TASK_NOT_READY",
        );
      }
      task.status = transitionTask(task.status, "IN_ACCEPTANCE");
      task.currentContractVersion = contractRecord.version;
      task.lastSubmittedCommit = targetCommit;
      task.updatedAt = this.clock.now();
      this.dependencies.store.updateTask(task);

      const run: AcceptanceRun = {
        id: createRunId(this.clock),
        projectId: project.id,
        taskId: task.id,
        targetCommit,
        contractVersion: contractRecord.version,
        testDataVersion: config.test_data?.version ?? "v1",
        gatePolicyVersion: config.gate?.policy_version ?? "v1",
        idempotencyKey,
        status: "CREATED",
        createdAt: this.clock.now(),
      };
      this.dependencies.store.createRun(run);
      this.dependencies.store.appendEvent(run.id, "TaskSubmitted", {
        project_id: project.id,
        task_id: task.id,
        target_commit: targetCommit,
        contract_hash: contractHash,
      });
      this.dependencies.store.appendEvent(run.id, "RunCreated", {
        run_id: run.id,
      });
      return { run, existing: false };
    });
  }

  private createContract(
    project: Project,
    task: Task,
    contract: AcceptanceContract,
    contractPath: string,
    contentHash: string,
  ): ContractRecord {
    const record: ContractRecord = {
      id: contract.contract_id,
      projectId: project.id,
      taskId: task.id,
      version: String(contract.version),
      path: resolve(contractPath),
      contentHash,
      status: "ACTIVE",
      createdAt: this.clock.now(),
    };
    this.dependencies.store.createContract(record);
    const requirements: RequirementRecord[] = contract.requirements.map(
      (requirement) => ({
        id: `${record.id}:${requirement.id}`,
        contractId: record.id,
        requirementKey: requirement.id,
        title: requirement.title,
        criticality: requirement.criticality,
        requiredEvidenceLevel: requirement.verification.required_evidence,
        verificationModes: requirement.verification.modes,
        humanRequired: requirement.human_required ?? false,
      }),
    );
    this.dependencies.store.createRequirements(requirements);
    return record;
  }

  startRun(runId: string): AcceptanceRun {
    const run = this.dependencies.store.getRun(runId);
    if (run.status !== "CREATED") return run;
    const startedAt = this.clock.now();
    const next = { ...run, status: "VALIDATING" as const, startedAt };
    this.dependencies.store.updateRun(next);
    this.dependencies.store.appendEvent(run.id, "TargetValidated", {
      target_commit: run.targetCommit,
    });
    return next;
  }

  getProjectOrThrow(id: string): Project {
    const project = this.dependencies.store.findProject(id);
    if (!project) throw new NotFoundError("project", id);
    return project;
  }
}
