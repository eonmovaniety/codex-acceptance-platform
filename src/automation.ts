import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AcceptanceContract,
  AcceptanceRun,
  AutomationJob,
  ExecutionScope,
  Project,
  ProjectConfig,
  RunTriggerSource,
} from "./domain.js";
import {
  loadAcceptanceContract,
  loadProjectConfig,
  sha256FileSync,
} from "./config.js";
import { AcceptanceController } from "./controller.js";
import { CapError } from "./errors.js";
import { createIdempotencyKey } from "./ids.js";
import type { GitClient } from "./git.js";
import { type AcceptanceHomePaths } from "./paths.js";
import { ArtifactStore } from "./artifacts.js";
import {
  buildAcceptanceSummary,
  createNotificationOutbox,
  notificationChannelsFor,
  NotificationDispatcher,
  renderSummaryMarkdown,
} from "./notifications.js";
import type { AcceptanceMatrix } from "./matrix.js";
import { loadGatePolicy, type RunExecutionResult } from "./orchestrator.js";
import { SqliteStore, systemClock, type Clock } from "./storage.js";
import { validateDocument } from "./validation.js";
import { sanitizedEnvironment } from "./runner.js";

export type AutomationSource = Exclude<RunTriggerSource, "manual">;

const AUTOMATION_LEASE_MS = 30 * 60 * 1000;

export interface EnqueueInput {
  projectId: string;
  taskId: string;
  commit: string;
  source: AutomationSource;
  eventId?: string;
  bestEffort?: boolean;
}

export interface EnqueueResult {
  existing: boolean;
  run?: AcceptanceRun;
  job: AutomationJob;
}

export interface AutomationDependencies {
  store: SqliteStore;
  home: AcceptanceHomePaths;
  git: GitClient;
  clock?: Clock;
  notifications?: NotificationDispatcher;
  executor?: (runId: string) => Promise<RunExecutionResult>;
  cycle?: () => Promise<void>;
}

export function executionScopeFor(source: AutomationSource): ExecutionScope {
  return source.startsWith("ci_") ? "ci" : "local";
}

export function resolveAutomationContractPath(
  projectConfigPath: string,
  configuredPath: string,
): string {
  const projectRoot = dirname(dirname(resolve(projectConfigPath)));
  const fromRoot = resolve(projectRoot, configuredPath);
  if (existsSync(fromRoot)) return fromRoot;
  return resolve(dirname(resolve(projectConfigPath)), configuredPath);
}

export function automationTaskConfig(
  config: ProjectConfig,
  taskId: string,
): { task_id: string; contract: string } {
  const task = config.automation?.tasks?.find(
    (candidate) => candidate.task_id === taskId,
  );
  if (!task)
    throw new CapError(
      `Automation task '${taskId}' is not configured`,
      "AUTOMATION_TASK_NOT_CONFIGURED",
    );
  return task;
}

export function maxAttemptsFor(config: ProjectConfig): number {
  const retries = config.automation?.retry?.infrastructure_max_attempts ?? 1;
  if (!Number.isInteger(retries) || retries < 0 || retries > 10)
    throw new CapError(
      "automation.retry.infrastructure_max_attempts must be an integer from 0 to 10",
      "AUTOMATION_CONFIG_INVALID",
    );
  return retries + 1;
}

export function validateAutomationConfig(config: ProjectConfig): void {
  const automation = config.automation;
  if (!automation?.enabled) return;
  const tasks = automation.tasks ?? [];
  if (tasks.length === 0)
    throw new CapError(
      "automation.tasks must contain at least one task when automation is enabled",
      "AUTOMATION_CONFIG_INVALID",
    );
  const taskIds = new Set<string>();
  for (const task of tasks) {
    if (taskIds.has(task.task_id))
      throw new CapError(
        `automation.tasks contains duplicate task_id '${task.task_id}'`,
        "AUTOMATION_CONFIG_INVALID",
      );
    taskIds.add(task.task_id);
  }
  const pollSeconds = automation.local?.poll_seconds ?? 5;
  if (!Number.isInteger(pollSeconds) || pollSeconds < 1)
    throw new CapError(
      "automation.local.poll_seconds must be a positive integer",
      "AUTOMATION_CONFIG_INVALID",
    );
  const concurrency = automation.local?.concurrency ?? 1;
  if (concurrency !== 1)
    throw new CapError(
      "CAP automation currently supports local concurrency = 1 only",
      "AUTOMATION_CONFIG_UNSUPPORTED",
    );
  const progressAfter = automation.notifications?.progress_after_seconds ?? 60;
  const progressInterval =
    automation.notifications?.progress_interval_seconds ?? 120;
  if (
    !Number.isInteger(progressAfter) ||
    progressAfter < 1 ||
    !Number.isInteger(progressInterval) ||
    progressInterval < 1
  )
    throw new CapError(
      "automation notification progress intervals must be positive integers",
      "AUTOMATION_CONFIG_INVALID",
    );
  maxAttemptsFor(config);
}

export function ensureAutomationSourceEnabled(
  config: ProjectConfig,
  source: AutomationSource,
): void {
  validateAutomationConfig(config);
  if (
    source === "post_commit" &&
    config.automation?.local?.post_commit === false
  )
    throw new CapError(
      "Local post-commit automation is disabled for this project",
      "AUTOMATION_SOURCE_DISABLED",
    );
  if (
    source === "ci_pull_request" &&
    config.automation?.ci?.pull_request === false
  )
    throw new CapError(
      "CI pull-request automation is disabled for this project",
      "AUTOMATION_SOURCE_DISABLED",
    );
}

export class AutomationService {
  private readonly clock: Clock;
  private readonly controller: AcceptanceController;
  private readonly notifications: NotificationDispatcher;

  constructor(private readonly dependencies: AutomationDependencies) {
    this.clock = dependencies.clock ?? systemClock;
    this.controller = new AcceptanceController({
      store: dependencies.store,
      git: dependencies.git,
      clock: this.clock,
    });
    this.notifications =
      dependencies.notifications ??
      new NotificationDispatcher({
        store: dependencies.store,
        artifacts: new ArtifactStore(dependencies.home),
        home: dependencies.home,
        clock: this.clock,
      });
  }

  async enqueue(input: EnqueueInput): Promise<EnqueueResult> {
    const project = this.dependencies.store.getProject(input.projectId);
    const config = await loadProjectConfig(project.configPath);
    ensureAutomationSourceEnabled(config, input.source);
    if (config.automation?.enabled !== true)
      throw new CapError(
        `Automation is disabled for project '${project.id}'`,
        "AUTOMATION_DISABLED",
      );
    const taskConfig = automationTaskConfig(config, input.taskId);
    const contractPath = resolveAutomationContractPath(
      project.configPath,
      taskConfig.contract,
    );
    const contract = await loadAcceptanceContract(contractPath);
    if (contract.task_id !== input.taskId)
      throw new CapError(
        `Automation task '${input.taskId}' does not match contract.task_id '${contract.task_id}'`,
        "CONTRACT_TASK_MISMATCH",
      );
    loadGatePolicy(config, project.configPath);
    const targetCommit = this.dependencies.git.resolveCommit(
      project.repoPath,
      input.commit,
    );
    const executionScope = executionScopeFor(input.source);
    const contractHash = sha256FileSync(contractPath);
    const idempotencyKey = createIdempotencyKey(
      project.id,
      input.taskId,
      targetCommit,
      contractHash,
      config.test_data?.version ?? "v1",
      config.gate?.policy_version ?? "v1",
      executionScope,
    );
    const existingJob =
      this.dependencies.store.findAutomationJobByIdempotencyKey(idempotencyKey);
    if (existingJob) {
      return {
        existing: true,
        ...(existingJob.runId
          ? { run: this.dependencies.store.getRun(existingJob.runId) }
          : {}),
        job: existingJob,
      };
    }

    const eventId =
      input.eventId ?? `${input.taskId}:${targetCommit}:${executionScope}`;
    const existingEvent = this.dependencies.store.findAutomationJobByEvent(
      executionScope,
      eventId,
    );
    if (existingEvent) {
      return {
        existing: true,
        ...(existingEvent.runId
          ? { run: this.dependencies.store.getRun(existingEvent.runId) }
          : {}),
        job: existingEvent,
      };
    }
    const now = this.clock.now();
    const maxAttempts = maxAttemptsFor(config);
    const dirty = this.dependencies.git
      .statusPorcelain(project.repoPath)
      .trim();
    if (
      config.repository.require_clean_submission &&
      dirty &&
      executionScope === "local"
    ) {
      const reason = "Submission requires a clean target repository";
      const submitted = this.controller.submit(
        project,
        config,
        contract,
        contractPath,
        targetCommit,
        {
          triggerSource: input.source,
          executionScope,
          allowDirty: true,
          blockedReason: reason,
        },
      );
      if (!submitted.existing)
        this.writeBlockedArtifacts(project, submitted.run, contract, reason);
      const task = this.dependencies.store.getTask(project.id, input.taskId);
      const job = this.blockedJob({
        projectId: project.id,
        taskId: task.id,
        runId: submitted.run.id,
        source: input.source,
        executionScope,
        eventId,
        idempotencyKey,
        maxAttempts,
        reason,
        now,
      });
      const persistedJob = this.persistJobAndNotification(
        job,
        config,
        "automation.blocked",
        {
          reason: job.lastError,
        },
      );
      await dispatchNotificationsSafely(this.notifications);
      return {
        existing: submitted.existing || persistedJob.id !== job.id,
        ...(persistedJob.runId === undefined
          ? {}
          : { run: this.dependencies.store.getRun(persistedJob.runId) }),
        job: persistedJob,
      };
    }

    let submitted;
    try {
      submitted = this.controller.submit(
        project,
        config,
        contract,
        contractPath,
        targetCommit,
        {
          triggerSource: input.source,
          executionScope,
          allowDirty: executionScope === "ci",
        },
      );
    } catch (error) {
      if (!input.bestEffort) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      const task = this.controller.ensureTask(project, contract);
      const job = this.blockedJob({
        projectId: project.id,
        taskId: task.id,
        source: input.source,
        executionScope,
        eventId,
        idempotencyKey,
        maxAttempts,
        reason,
        now,
      });
      const persistedJob = this.persistJobAndNotification(
        job,
        config,
        "automation.blocked",
        {
          reason,
        },
      );
      await dispatchNotificationsSafely(this.notifications);
      return { existing: persistedJob.id !== job.id, job: persistedJob };
    }

    const run = submitted.run;
    const existingTerminal = isTerminalRun(run);
    const job: AutomationJob = {
      id: `JOB-${randomUUID().slice(0, 8).toUpperCase()}`,
      projectId: project.id,
      taskId: input.taskId,
      runId: run.id,
      source: input.source,
      executionScope,
      eventId,
      idempotencyKey,
      status: existingTerminal ? "SUCCEEDED" : "QUEUED",
      attempts: 0,
      maxAttempts,
      nextAttemptAt: now,
      createdAt: now,
      updatedAt: now,
      ...(existingTerminal ? { completedAt: now } : {}),
    };
    const persistedJob = this.persistJobAndNotification(
      job,
      config,
      "automation.enqueued",
      {
        source: input.source,
        target_commit: targetCommit,
      },
    );
    await dispatchNotificationsSafely(this.notifications);
    return {
      existing: submitted.existing || persistedJob.id !== job.id,
      ...(persistedJob.runId === undefined
        ? {}
        : { run: this.dependencies.store.getRun(persistedJob.runId) }),
      job: persistedJob,
    };
  }

  private blockedJob(input: {
    projectId: string;
    taskId: string;
    runId?: string;
    source: AutomationSource;
    executionScope: ExecutionScope;
    eventId: string;
    idempotencyKey: string;
    maxAttempts: number;
    reason: string;
    now: string;
  }): AutomationJob {
    return {
      id: `JOB-${randomUUID().slice(0, 8).toUpperCase()}`,
      projectId: input.projectId,
      taskId: input.taskId,
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      source: input.source,
      executionScope: input.executionScope,
      eventId: input.eventId,
      idempotencyKey: input.idempotencyKey,
      status: "BLOCKED",
      attempts: 0,
      maxAttempts: input.maxAttempts,
      nextAttemptAt: input.now,
      lastError: input.reason,
      createdAt: input.now,
      updatedAt: input.now,
      completedAt: input.now,
    };
  }

  private writeBlockedArtifacts(
    project: Project,
    run: AcceptanceRun,
    contract: AcceptanceContract,
    reason: string,
  ): void {
    const artifacts = new ArtifactStore(this.dependencies.home, () =>
      this.clock.now(),
    );
    const matrix: AcceptanceMatrix = {
      version: 1,
      run_id: run.id,
      requirements: contract.requirements.map((requirement) => ({
        id: requirement.id,
        title: requirement.title,
        criticality: requirement.criticality,
        result: "NOT_TESTED",
        required_evidence: requirement.verification.required_evidence,
        actual_evidence: "E0",
        artifacts: [],
        evidence_valid: false,
        finding_ids: [],
        human_required: requirement.human_required ?? false,
      })),
      coverage: {
        total: contract.requirements.length,
        pass: 0,
        fail: 0,
        not_tested: contract.requirements.length,
        blocked: 0,
        not_applicable: 0,
      },
    };
    validateDocument("acceptance-matrix", matrix);
    artifacts.writeJson(project.id, run.taskId, run.id, "run/blocked.json", {
      version: 1,
      run_id: run.id,
      reason,
    });
    artifacts.writeJson(
      project.id,
      run.taskId,
      run.id,
      "acceptance/matrix.json",
      matrix,
    );
    const summary = buildAcceptanceSummary({
      run,
      project,
      matrix,
      evidencePaths: ["run/blocked.json", "acceptance/matrix.json"],
      nextAction: "清理目标工作区后重新触发自动验收；未提交内容不会进入 Run。",
    });
    validateDocument("acceptance-summary", summary);
    artifacts.writeJson(
      project.id,
      run.taskId,
      run.id,
      "acceptance/summary.json",
      summary,
    );
    artifacts.writeText(
      project.id,
      run.taskId,
      run.id,
      "acceptance/summary.md",
      renderSummaryMarkdown(summary),
    );
    artifacts.finalize(project.id, run.taskId, run.id);
  }

  private persistJobAndNotification(
    job: AutomationJob,
    config: ProjectConfig,
    eventType: string,
    payload: Record<string, unknown>,
  ): AutomationJob {
    const channels = notificationChannelsFor(config, job.source, eventType);
    try {
      return this.dependencies.store.withTransaction(() => {
        const existing =
          this.dependencies.store.findAutomationJobByIdempotencyKey(
            job.idempotencyKey,
          );
        if (existing) return existing;
        this.dependencies.store.createAutomationJob(job);
        if (job.runId)
          this.dependencies.store.appendEvent(job.runId, "AutomationEnqueued", {
            source: job.source,
            execution_scope: job.executionScope,
            job_id: job.id,
          });
        if (channels.length > 0) {
          const outbox = createNotificationOutbox({
            eventType,
            ...(job.runId === undefined ? {} : { runId: job.runId }),
            jobId: job.id,
            source: job.source,
            channels,
            payload,
            now: () => this.clock.now(),
          });
          if (
            !this.dependencies.store.findNotificationOutboxByDedupeKey(
              outbox.dedupeKey,
            )
          )
            this.dependencies.store.createNotificationOutbox(outbox);
        }
        return job;
      });
    } catch (error) {
      const existing =
        this.dependencies.store.findAutomationJobByIdempotencyKey(
          job.idempotencyKey,
        ) ??
        this.dependencies.store.findAutomationJobByEvent(
          job.executionScope,
          job.eventId,
        );
      if (existing) return existing;
      throw error;
    }
  }
}

export interface WorkerResult {
  processed: boolean;
  job?: AutomationJob;
  run?: AcceptanceRun;
}

export class AutomationWorker {
  private readonly clock: Clock;
  private readonly owner = `worker-${process.pid}-${randomUUID()}`;
  private readonly controller: AcceptanceController;
  private readonly notifications: NotificationDispatcher;
  private readonly execute: (runId: string) => Promise<RunExecutionResult>;
  private stopRequested = false;

  constructor(private readonly dependencies: AutomationDependencies) {
    this.clock = dependencies.clock ?? systemClock;
    this.controller = new AcceptanceController({
      store: dependencies.store,
      git: dependencies.git,
      clock: this.clock,
    });
    this.notifications =
      dependencies.notifications ??
      new NotificationDispatcher({
        store: dependencies.store,
        artifacts: new ArtifactStore(dependencies.home),
        home: dependencies.home,
        clock: this.clock,
      });
    this.execute =
      dependencies.executor ??
      ((runId) => executeRunInChildProcess(runId, dependencies.home));
  }

  requestStop(): void {
    this.stopRequested = true;
  }

  async runOnce(): Promise<WorkerResult> {
    await this.dependencies.cycle?.();
    await dispatchNotificationsSafely(this.notifications);
    const now = this.clock.now();
    const leaseExpiresAt = new Date(
      Date.parse(now) + AUTOMATION_LEASE_MS,
    ).toISOString();
    const job = this.dependencies.store.claimNextAutomationJob(
      this.owner,
      leaseExpiresAt,
      now,
    );
    if (!job) return { processed: false };
    if (!job.runId) {
      const blocked = clearJobLease({
        ...job,
        status: "BLOCKED",
        lastError: job.lastError ?? "Automation job has no Run",
        completedAt: this.clock.now(),
        updatedAt: this.clock.now(),
      });
      this.dependencies.store.updateAutomationJob(blocked);
      return { processed: true, job: blocked };
    }
    const running = {
      ...job,
      status: "RUNNING" as const,
      updatedAt: this.clock.now(),
    };
    this.dependencies.store.updateAutomationJob(running);
    this.dependencies.store.withTransaction(() => {
      this.dependencies.store.appendEvent(job.runId!, "AutomationStarted", {
        job_id: job.id,
        attempt: running.attempts,
      });
    });
    let projectConfig: ProjectConfig | undefined;
    try {
      projectConfig = await loadProjectConfig(
        this.dependencies.store.getProject(running.projectId).configPath,
      );
    } catch {
      // The executor owns the acceptance failure; notification setup is best effort.
    }
    await this.persistWorkerNotification(running, "automation.started", {
      source: running.source,
      target_commit: this.dependencies.store.getRun(job.runId).targetCommit,
    }).catch(() => {
      // Notification faults must not affect the acceptance Run.
    });
    const stopProgress = this.startProgressNotifications(
      running,
      projectConfig,
    );
    try {
      await this.execute(job.runId);
      const run = this.dependencies.store.getRun(job.runId);
      if (!isTerminalRun(run))
        throw new CapError(
          `Acceptance executor returned before terminal state for ${run.id}: ${run.status}`,
          "RUN_NOT_TERMINAL",
        );
      const completed = clearJobLease({
        ...running,
        status: "SUCCEEDED",
        updatedAt: this.clock.now(),
        completedAt: this.clock.now(),
      });
      this.dependencies.store.updateAutomationJob(completed);
      await dispatchNotificationsSafely(this.notifications);
      return { processed: true, job: completed, run };
    } catch (error) {
      const run = this.dependencies.store.getRun(job.runId);
      const message = error instanceof Error ? error.message : String(error);
      if (run.status === "INFRA_FAILED" && job.attempts < job.maxAttempts) {
        const retry = this.controller.retryInfrastructureRun(run);
        const retryJob = clearJobLease({
          ...running,
          runId: retry.id,
          status: "RETRY_WAIT",
          nextAttemptAt: new Date(
            Date.parse(this.clock.now()) + 5_000,
          ).toISOString(),
          lastError: message,
          updatedAt: this.clock.now(),
        });
        this.dependencies.store.updateAutomationJob(retryJob);
        await dispatchNotificationsSafely(this.notifications);
        return { processed: true, job: retryJob, run: retry };
      }
      const dead = clearJobLease({
        ...running,
        status: "DEAD_LETTER",
        lastError: message,
        updatedAt: this.clock.now(),
        completedAt: this.clock.now(),
      });
      this.dependencies.store.updateAutomationJob(dead);
      await this.persistFailureNotification(dead, run, message);
      await dispatchNotificationsSafely(this.notifications);
      return { processed: true, job: dead, run };
    } finally {
      stopProgress();
    }
  }

  async runUntil(
    runId: string,
    timeoutMs = 30 * 60 * 1000,
  ): Promise<AcceptanceRun> {
    const initialJob = this.dependencies.store.findAutomationJobByRunId(runId);
    if (!initialJob)
      throw new CapError(
        `Automation job for Run '${runId}' was not found`,
        "AUTOMATION_JOB_NOT_FOUND",
      );
    const jobId = initialJob.id;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const job = this.dependencies.store.getAutomationJob(jobId);
      const currentRun = this.dependencies.store.getRun(job.runId ?? runId);
      if (isTerminalRun(currentRun)) return currentRun;
      if (
        job.status === "BLOCKED" ||
        job.status === "FAILED" ||
        job.status === "DEAD_LETTER"
      )
        return currentRun;
      const result = await this.runOnce();
      if (!result.processed) await delay(250);
    }
    throw new CapError(
      `Automation Run timed out while waiting: ${runId}`,
      "AUTOMATION_TIMEOUT",
    );
  }

  async runForever(
    pollSeconds = 5,
    log: (message: string) => void = console.log,
  ): Promise<void> {
    this.stopRequested = false;
    log(`CAP automation worker started (owner=${this.owner})`);
    while (!this.stopRequested) {
      const result = await this.runOnce();
      if (!result.processed) await delay(Math.max(1, pollSeconds) * 1000);
    }
    log("CAP automation worker stopped");
  }

  private async persistFailureNotification(
    job: AutomationJob,
    run: AcceptanceRun,
    error: string,
  ): Promise<void> {
    await this.persistWorkerNotification(job, "automation.failed", {
      reason: error,
      status: run.status,
    });
  }

  private async persistWorkerNotification(
    job: AutomationJob,
    eventType: string,
    payload: Record<string, unknown>,
    dedupeSuffix?: string,
  ): Promise<void> {
    const project = this.dependencies.store.getProject(job.projectId);
    const config = await loadProjectConfig(project.configPath);
    const channels = notificationChannelsFor(config, job.source, eventType);
    if (channels.length === 0) return;
    this.dependencies.store.withTransaction(() => {
      const outbox = createNotificationOutbox({
        eventType,
        ...(job.runId === undefined ? {} : { runId: job.runId }),
        jobId: job.id,
        source: job.source,
        channels,
        payload,
        ...(dedupeSuffix === undefined ? {} : { dedupeSuffix }),
        now: () => this.clock.now(),
      });
      if (
        !this.dependencies.store.findNotificationOutboxByDedupeKey(
          outbox.dedupeKey,
        )
      )
        this.dependencies.store.createNotificationOutbox(outbox);
    });
  }

  private startProgressNotifications(
    job: AutomationJob,
    config?: ProjectConfig,
  ): () => void {
    let stopped = false;
    let interval: NodeJS.Timeout | undefined;
    const progressAfterSeconds =
      config?.automation?.notifications?.progress_after_seconds ?? 60;
    const progressIntervalSeconds =
      config?.automation?.notifications?.progress_interval_seconds ?? 120;
    const send = (): void => {
      if (stopped || !job.runId) return;
      let run: AcceptanceRun;
      try {
        run = this.dependencies.store.getRun(job.runId);
      } catch {
        return;
      }
      const startedAt = run.startedAt ? Date.parse(run.startedAt) : Date.now();
      const elapsedSeconds = Math.max(
        0,
        Math.round((Date.now() - startedAt) / 1000),
      );
      const progressNumber = Math.max(
        1,
        Math.floor(
          (elapsedSeconds - progressAfterSeconds) / progressIntervalSeconds,
        ) + 1,
      );
      const suffix = `progress-${String(progressNumber)}`;
      void this.persistWorkerNotification(
        job,
        "automation.progress",
        {
          source: job.source,
          stage: run.status,
          elapsed_seconds: elapsedSeconds,
        },
        suffix,
      ).catch(() => {
        // Notification faults must not affect the acceptance Run.
      });
    };
    const first = setTimeout(() => {
      if (stopped) return;
      send();
      interval = setInterval(send, progressIntervalSeconds * 1000);
      interval.unref?.();
    }, progressAfterSeconds * 1000);
    first.unref?.();
    return () => {
      stopped = true;
      clearTimeout(first);
      if (interval) clearInterval(interval);
    };
  }
}

function clearJobLease(job: AutomationJob): AutomationJob {
  const {
    leaseOwner: _leaseOwner,
    leaseExpiresAt: _leaseExpiresAt,
    ...withoutLease
  } = job;
  return withoutLease;
}

function isTerminalRun(run: AcceptanceRun): boolean {
  return [
    "COMPLETED_PASS",
    "COMPLETED_FAIL",
    "COMPLETED_HUMAN",
    "CANCELLED",
    "INVALID",
    "BLOCKED",
  ].includes(run.status);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) =>
    setTimeout(resolvePromise, milliseconds),
  );
}

async function dispatchNotificationsSafely(
  dispatcher: NotificationDispatcher,
): Promise<void> {
  try {
    await dispatcher.dispatchPending();
  } catch {
    // Notification faults are observable in the outbox and never alter the Gate.
  }
}

function executeRunInChildProcess(
  runId: string,
  home: AcceptanceHomePaths,
): Promise<RunExecutionResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      [findCliPath(), "run", "execute", runId, "--home", home.root, "--json"],
      {
        cwd: findCapRoot(),
        env: sanitizedEnvironment({ CAP_AUTOMATION_RUN: "1" }),
        windowsHide: true,
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => reject(error));
    child.once("close", (code, signal) => {
      if (code !== 0) {
        reject(
          new CapError(
            `Acceptance child process failed (code=${String(code)}, signal=${String(signal)}): ${stderr.trim()}`,
            "AUTOMATION_EXECUTOR_FAILED",
          ),
        );
        return;
      }
      try {
        resolvePromise(JSON.parse(stdout) as RunExecutionResult);
      } catch (error) {
        reject(
          new CapError(
            `Acceptance child process returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
            "AUTOMATION_EXECUTOR_OUTPUT_INVALID",
          ),
        );
      }
    });
  });
}

export interface AutomationInstallRecord {
  version: 1;
  project_id: string;
  task_id: string;
  repo_path: string;
  cap_home: string;
  cli_path: string;
  node_path: string;
  hook_path: string;
  original_hook_path?: string;
  worker_task_name?: string;
  installed_at: string;
}

export interface TaskScheduler {
  createLoginTask(name: string, command: string): void;
  deleteTask(name: string): void;
  runTask(name: string): void;
}

export class WindowsTaskScheduler implements TaskScheduler {
  createLoginTask(name: string, command: string): void {
    const result = spawnSync(
      "schtasks.exe",
      [
        "/Create",
        "/SC",
        "ONLOGON",
        "/TN",
        name,
        "/TR",
        command,
        "/F",
        "/IT",
        "/RL",
        "LIMITED",
      ],
      { encoding: "utf8", windowsHide: true },
    );
    if (result.status !== 0)
      throw new CapError(
        `Could not register Windows Worker task: ${result.stderr.trim()}`,
        "AUTOMATION_TASK_REGISTER_FAILED",
      );
    const restart = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable; Set-ScheduledTask -TaskName ${quotePowerShell(name)} -Settings $settings | Out-Null`,
      ],
      { encoding: "utf8", windowsHide: true },
    );
    if (restart.status !== 0) {
      this.deleteTask(name);
      throw new CapError(
        `Could not configure Windows Worker restart policy: ${restart.stderr.trim()}`,
        "AUTOMATION_TASK_SETTINGS_FAILED",
      );
    }
  }

  deleteTask(name: string): void {
    const result = spawnSync("schtasks.exe", ["/Delete", "/TN", name, "/F"], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (
      result.status !== 0 &&
      !/does not exist|not found|cannot find|no such/i.test(
        `${result.stderr}\n${result.stdout}`,
      )
    )
      throw new CapError(
        `Could not remove Windows Worker task: ${result.stderr.trim()}`,
        "AUTOMATION_TASK_REMOVE_FAILED",
      );
  }

  runTask(name: string): void {
    const result = spawnSync("schtasks.exe", ["/Run", "/TN", name], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.status !== 0)
      throw new CapError(
        `Could not start Windows Worker task: ${result.stderr.trim()}`,
        "AUTOMATION_TASK_START_FAILED",
      );
  }
}

export function installAutomation(input: {
  projectId: string;
  taskId: string;
  repoPath: string;
  git: GitClient;
  home: AcceptanceHomePaths;
  cliPath?: string;
  nodePath?: string;
  now?: () => string;
  scheduler?: TaskScheduler;
}): AutomationInstallRecord {
  const gitDir = input.git.gitDir(input.repoPath);
  const hooksDir = join(gitDir, "hooks");
  const automationDir = join(gitDir, "cap-automation");
  mkdirSync(hooksDir, { recursive: true });
  mkdirSync(automationDir, { recursive: true });
  const hookPath = join(hooksDir, "post-commit");
  const originalHookPath = join(automationDir, "original-post-commit");
  const hadExistingHook = existsSync(hookPath);
  const existing = hadExistingHook ? readFileSync(hookPath, "utf8") : "";
  const installationPath = join(automationDir, "installation.json");
  const previousInstallation = existsSync(installationPath)
    ? readFileSync(installationPath, "utf8")
    : undefined;
  const hadOriginalHookBackup = existsSync(originalHookPath);
  let preservedOriginal: string | undefined;
  let createdOriginalHookBackup = false;
  if (existing && !existing.includes("CAP_AUTOMATION_HOOK_BEGIN")) {
    copyFileSync(hookPath, originalHookPath);
    preservedOriginal = originalHookPath;
    createdOriginalHookBackup = !hadOriginalHookBackup;
  } else if (existsSync(originalHookPath)) {
    preservedOriginal = originalHookPath;
  }
  const cliPath = resolve(
    input.cliPath ?? join(dirname(fileURLToPath(import.meta.url)), "cli.js"),
  );
  const nodePath = resolve(input.nodePath ?? process.execPath);
  const record: AutomationInstallRecord = {
    version: 1,
    project_id: input.projectId,
    task_id: input.taskId,
    repo_path: resolve(input.repoPath),
    cap_home: input.home.root,
    cli_path: cliPath,
    node_path: nodePath,
    hook_path: hookPath,
    ...(preservedOriginal === undefined
      ? {}
      : { original_hook_path: preservedOriginal }),
    ...(process.platform === "win32"
      ? { worker_task_name: "CAP Acceptance Worker" }
      : {}),
    installed_at: (input.now ?? systemClock.now)(),
  };
  let scheduler: TaskScheduler | undefined;
  let taskCreated = false;
  try {
    writeFileSync(
      installationPath,
      `${JSON.stringify(record, null, 2)}\n`,
      "utf8",
    );
    writeFileSync(
      hookPath,
      renderPostCommitHook(record, preservedOriginal),
      "utf8",
    );
    chmodSync(hookPath, 0o755);
    if (process.platform === "win32") {
      scheduler = input.scheduler ?? new WindowsTaskScheduler();
      const command = `${quoteWindows(nodePath)} ${quoteWindows(cliPath)} automation worker --serve --home ${quoteWindows(input.home.root)}`;
      scheduler.createLoginTask(
        record.worker_task_name ?? "CAP Acceptance Worker",
        command,
      );
      taskCreated = true;
      scheduler.runTask(record.worker_task_name ?? "CAP Acceptance Worker");
    }
  } catch (error) {
    if (taskCreated && scheduler && record.worker_task_name) {
      try {
        scheduler.deleteTask(record.worker_task_name);
      } catch {
        // Preserve the original install error; the task can be removed manually.
      }
    }
    if (hadExistingHook) writeFileSync(hookPath, existing, "utf8");
    else if (existsSync(hookPath)) unlinkSync(hookPath);
    if (createdOriginalHookBackup && existsSync(originalHookPath))
      unlinkSync(originalHookPath);
    if (previousInstallation === undefined) {
      if (existsSync(installationPath)) unlinkSync(installationPath);
    } else {
      writeFileSync(installationPath, previousInstallation, "utf8");
    }
    throw error;
  }
  return record;
}

export function uninstallAutomation(input: {
  repoPath: string;
  git: GitClient;
  scheduler?: TaskScheduler;
}): { removed: boolean; restored: boolean; task_removed: boolean } {
  const gitDir = input.git.gitDir(input.repoPath);
  const automationDir = join(gitDir, "cap-automation");
  const installationPath = join(automationDir, "installation.json");
  if (!existsSync(installationPath))
    return { removed: false, restored: false, task_removed: false };
  const record = JSON.parse(
    readFileSync(installationPath, "utf8"),
  ) as AutomationInstallRecord;
  const hookPath = record.hook_path;
  let removed = false;
  let restored = false;
  if (existsSync(hookPath)) {
    const content = readFileSync(hookPath, "utf8");
    if (content.includes("CAP_AUTOMATION_HOOK_BEGIN")) {
      unlinkSync(hookPath);
      removed = true;
      if (record.original_hook_path && existsSync(record.original_hook_path)) {
        copyFileSync(record.original_hook_path, hookPath);
        chmodSync(hookPath, 0o755);
        restored = true;
      }
    }
  }
  let taskRemoved = false;
  if (record.worker_task_name && process.platform === "win32") {
    (input.scheduler ?? new WindowsTaskScheduler()).deleteTask(
      record.worker_task_name,
    );
    taskRemoved = true;
  }
  unlinkSync(installationPath);
  return { removed, restored, task_removed: taskRemoved };
}

export function readAutomationInstallation(
  repoPath: string,
  git: GitClient,
): AutomationInstallRecord | undefined {
  const path = join(
    git.gitDir(repoPath),
    "cap-automation",
    "installation.json",
  );
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as AutomationInstallRecord;
}

function renderPostCommitHook(
  record: AutomationInstallRecord,
  originalHookPath: string | undefined,
): string {
  const original = originalHookPath
    ? [
        `if [ -f ${quoteShell(originalHookPath)} ]; then`,
        `  /bin/sh ${quoteShell(originalHookPath)} "$@" || true`,
        "fi",
      ]
    : [];
  return [
    "#!/bin/sh",
    "# CAP_AUTOMATION_HOOK_BEGIN",
    "# This file is managed by CAP. It never blocks the Git commit.",
    "export CAP_AUTOMATION_RUN=1",
    `${quoteShell(record.node_path)} ${quoteShell(record.cli_path)} automation enqueue --project ${quoteShell(record.project_id)} --task ${quoteShell(record.task_id)} --commit HEAD --source post_commit --home ${quoteShell(record.cap_home)} --best-effort --json || echo \"CAP automation enqueue failed; commit remains valid\" >&2`,
    ...original,
    "# CAP_AUTOMATION_HOOK_END",
    "exit 0",
    "",
  ].join("\n");
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function quoteWindows(value: string): string {
  return `"${value.replaceAll('"', '\\"')}"`;
}

function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function findCliPath(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(moduleDirectory, "cli.js"),
    resolve(moduleDirectory, "..", "dist", "src", "cli.js"),
    resolve(process.cwd(), "dist", "src", "cli.js"),
  ];
  return (
    candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!
  );
}

function findCapRoot(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(moduleDirectory, "..", ".."),
    resolve(moduleDirectory, ".."),
    process.cwd(),
  ];
  return (
    candidates.find((candidate) =>
      existsSync(resolve(candidate, "package.json")),
    ) ?? process.cwd()
  );
}
