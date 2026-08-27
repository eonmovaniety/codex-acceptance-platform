import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AcceptanceRun,
  AutomationJob,
  AutomationJobStatus,
  ContractRecord,
  NotificationDelivery,
  NotificationOutboxItem,
  NotificationStatus,
  Project,
  RequirementRecord,
  ResourceLease,
  RunEvent,
  RunStatus,
  Task,
  TaskStatus,
} from "./domain.js";
import { ImmutableRunError, NotFoundError } from "./errors.js";

export interface Clock {
  now(): string;
}

export const systemClock: Clock = {
  now: () => new Date().toISOString(),
};

interface Migration {
  version: string;
  sql: string;
}

const migrations: Migration[] = [
  {
    version: "0001_bootstrap",
    sql: `CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );`,
  },
  {
    version: "0002_domain",
    sql: `
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        repo_path TEXT NOT NULL,
        base_branch TEXT NOT NULL,
        config_path TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'PAUSED')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id),
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        risk_level TEXT NOT NULL CHECK (risk_level IN ('R0', 'R1', 'R2', 'R3')),
        current_contract_version TEXT,
        last_submitted_commit TEXT,
        accepted_commit TEXT,
        failure_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (project_id, id)
      );
      CREATE TABLE IF NOT EXISTS contracts (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        task_id TEXT NOT NULL,
        version TEXT NOT NULL,
        path TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (project_id, task_id, version),
        FOREIGN KEY (project_id, task_id) REFERENCES tasks(project_id, id)
      );
      CREATE TABLE IF NOT EXISTS requirements (
        id TEXT PRIMARY KEY,
        contract_id TEXT NOT NULL REFERENCES contracts(id),
        requirement_key TEXT NOT NULL,
        title TEXT NOT NULL,
        criticality TEXT NOT NULL,
        required_evidence_level TEXT NOT NULL,
        verification_modes_json TEXT NOT NULL,
        human_required INTEGER NOT NULL DEFAULT 0,
        UNIQUE (contract_id, requirement_key)
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        task_id TEXT NOT NULL,
        target_commit TEXT NOT NULL,
        contract_version TEXT NOT NULL,
        test_data_version TEXT NOT NULL,
        gate_policy_version TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        decision TEXT,
        reviewer_thread_id TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        FOREIGN KEY (project_id, task_id) REFERENCES tasks(project_id, id)
      );
      CREATE TABLE IF NOT EXISTS run_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(id),
        sequence INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (run_id, sequence)
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
      CREATE INDEX IF NOT EXISTS idx_runs_project_task ON runs(project_id, task_id);
    `,
  },
  {
    version: "0003_resource_leases",
    sql: `
      CREATE TABLE IF NOT EXISTS resource_leases (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        resource_type TEXT NOT NULL,
        resource_key TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'RELEASED', 'EXPIRED')),
        expires_at TEXT NOT NULL,
        UNIQUE (resource_type, resource_key, status)
      );
      CREATE INDEX IF NOT EXISTS idx_resource_leases_run ON resource_leases(run_id);
    `,
  },
  {
    version: "0004_automation",
    sql: `
      ALTER TABLE runs ADD COLUMN trigger_source TEXT NOT NULL DEFAULT 'manual';
      ALTER TABLE runs ADD COLUMN execution_scope TEXT NOT NULL DEFAULT 'local';
      ALTER TABLE runs ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE runs ADD COLUMN retry_of TEXT;
      CREATE INDEX IF NOT EXISTS idx_runs_scope_commit
        ON runs(project_id, task_id, target_commit, execution_scope);

      CREATE TABLE IF NOT EXISTS automation_jobs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        task_id TEXT NOT NULL,
        run_id TEXT REFERENCES runs(id),
        source TEXT NOT NULL CHECK (source IN ('post_commit', 'ci_pull_request', 'ci_push')),
        execution_scope TEXT NOT NULL CHECK (execution_scope IN ('local', 'ci')),
        event_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN (
          'QUEUED', 'CLAIMED', 'RUNNING', 'RETRY_WAIT', 'SUCCEEDED',
          'FAILED', 'BLOCKED', 'DEAD_LETTER'
        )),
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 1,
        lease_owner TEXT,
        lease_expires_at TEXT,
        next_attempt_at TEXT NOT NULL,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        UNIQUE (execution_scope, event_id)
      );
      CREATE INDEX IF NOT EXISTS idx_automation_jobs_ready
        ON automation_jobs(status, next_attempt_at, created_at);
      CREATE INDEX IF NOT EXISTS idx_automation_jobs_project
        ON automation_jobs(project_id, task_id, created_at);

      CREATE TABLE IF NOT EXISTS notification_outbox (
        id TEXT PRIMARY KEY,
        run_id TEXT REFERENCES runs(id),
        job_id TEXT REFERENCES automation_jobs(id),
        event_type TEXT NOT NULL,
        dedupe_key TEXT NOT NULL UNIQUE,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('PENDING', 'SENDING', 'SENT', 'FAILED')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL,
        last_error TEXT,
        created_at TEXT NOT NULL,
        sent_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_notification_outbox_ready
        ON notification_outbox(status, next_attempt_at, created_at);

      CREATE TABLE IF NOT EXISTS notification_deliveries (
        id TEXT PRIMARY KEY,
        outbox_id TEXT NOT NULL REFERENCES notification_outbox(id),
        channel TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('PENDING', 'SENDING', 'SENT', 'FAILED')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL,
        last_error TEXT,
        created_at TEXT NOT NULL,
        sent_at TEXT,
        UNIQUE (outbox_id, channel)
      );
      CREATE INDEX IF NOT EXISTS idx_notification_deliveries_ready
        ON notification_deliveries(status, next_attempt_at, created_at);
    `,
  },
];

type Row = Record<string, unknown>;

function text(value: unknown): string {
  return String(value);
}

function nullableText(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

function mapProject(row: Row): Project {
  return {
    id: text(row.id),
    name: text(row.name),
    repoPath: text(row.repo_path),
    baseBranch: text(row.base_branch),
    configPath: text(row.config_path),
    status: row.status as Project["status"],
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

function mapTask(row: Row): Task {
  const currentContractVersion = nullableText(row.current_contract_version);
  const lastSubmittedCommit = nullableText(row.last_submitted_commit);
  const acceptedCommit = nullableText(row.accepted_commit);
  return {
    id: text(row.id),
    projectId: text(row.project_id),
    title: text(row.title),
    status: row.status as TaskStatus,
    riskLevel: row.risk_level as Task["riskLevel"],
    ...(currentContractVersion === undefined ? {} : { currentContractVersion }),
    ...(lastSubmittedCommit === undefined ? {} : { lastSubmittedCommit }),
    ...(acceptedCommit === undefined ? {} : { acceptedCommit }),
    failureCount: Number(row.failure_count),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

function mapContract(row: Row): ContractRecord {
  return {
    id: text(row.id),
    projectId: text(row.project_id),
    taskId: text(row.task_id),
    version: text(row.version),
    path: text(row.path),
    contentHash: text(row.content_hash),
    status: row.status as ContractRecord["status"],
    createdAt: text(row.created_at),
  };
}

function mapRequirement(row: Row): RequirementRecord {
  return {
    id: text(row.id),
    contractId: text(row.contract_id),
    requirementKey: text(row.requirement_key),
    title: text(row.title),
    criticality: row.criticality as RequirementRecord["criticality"],
    requiredEvidenceLevel:
      row.required_evidence_level as RequirementRecord["requiredEvidenceLevel"],
    verificationModes: JSON.parse(
      text(row.verification_modes_json),
    ) as string[],
    humanRequired: Number(row.human_required) === 1,
  };
}

function mapRun(row: Row): AcceptanceRun {
  const decision = nullableText(row.decision);
  const reviewerThreadId = nullableText(row.reviewer_thread_id);
  const startedAt = nullableText(row.started_at);
  const completedAt = nullableText(row.completed_at);
  const retryOf = nullableText(row.retry_of);
  const triggerSource = nullableText(row.trigger_source);
  const executionScope = nullableText(row.execution_scope);
  return {
    id: text(row.id),
    projectId: text(row.project_id),
    taskId: text(row.task_id),
    targetCommit: text(row.target_commit),
    contractVersion: text(row.contract_version),
    testDataVersion: text(row.test_data_version),
    gatePolicyVersion: text(row.gate_policy_version),
    idempotencyKey: text(row.idempotency_key),
    status: row.status as RunStatus,
    ...(decision === undefined
      ? {}
      : { decision: decision as NonNullable<AcceptanceRun["decision"]> }),
    ...(reviewerThreadId === undefined ? {} : { reviewerThreadId }),
    ...(triggerSource === undefined
      ? {}
      : {
          triggerSource: triggerSource as NonNullable<
            AcceptanceRun["triggerSource"]
          >,
        }),
    ...(executionScope === undefined
      ? {}
      : {
          executionScope: executionScope as NonNullable<
            AcceptanceRun["executionScope"]
          >,
        }),
    ...(row.attempt === undefined ? {} : { attempt: Number(row.attempt) }),
    ...(retryOf === undefined ? {} : { retryOf }),
    createdAt: text(row.created_at),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(completedAt === undefined ? {} : { completedAt }),
  };
}

function mapAutomationJob(row: Row): AutomationJob {
  const runId = nullableText(row.run_id);
  const leaseOwner = nullableText(row.lease_owner);
  const leaseExpiresAt = nullableText(row.lease_expires_at);
  const lastError = nullableText(row.last_error);
  const startedAt = nullableText(row.started_at);
  const completedAt = nullableText(row.completed_at);
  return {
    id: text(row.id),
    projectId: text(row.project_id),
    taskId: text(row.task_id),
    ...(runId === undefined ? {} : { runId }),
    source: row.source as AutomationJob["source"],
    executionScope: row.execution_scope as AutomationJob["executionScope"],
    eventId: text(row.event_id),
    idempotencyKey: text(row.idempotency_key),
    status: row.status as AutomationJobStatus,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    ...(leaseOwner === undefined ? {} : { leaseOwner }),
    ...(leaseExpiresAt === undefined ? {} : { leaseExpiresAt }),
    nextAttemptAt: text(row.next_attempt_at),
    ...(lastError === undefined ? {} : { lastError }),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(completedAt === undefined ? {} : { completedAt }),
  };
}

function mapNotificationOutbox(row: Row): NotificationOutboxItem {
  const runId = nullableText(row.run_id);
  const jobId = nullableText(row.job_id);
  const lastError = nullableText(row.last_error);
  const sentAt = nullableText(row.sent_at);
  return {
    id: text(row.id),
    ...(runId === undefined ? {} : { runId }),
    ...(jobId === undefined ? {} : { jobId }),
    eventType: text(row.event_type),
    dedupeKey: text(row.dedupe_key),
    payload: JSON.parse(text(row.payload_json)) as Record<string, unknown>,
    status: row.status as NotificationStatus,
    attempts: Number(row.attempts),
    nextAttemptAt: text(row.next_attempt_at),
    ...(lastError === undefined ? {} : { lastError }),
    createdAt: text(row.created_at),
    ...(sentAt === undefined ? {} : { sentAt }),
  };
}

function mapNotificationDelivery(row: Row): NotificationDelivery {
  const lastError = nullableText(row.last_error);
  const sentAt = nullableText(row.sent_at);
  return {
    id: text(row.id),
    outboxId: text(row.outbox_id),
    channel: text(row.channel),
    status: row.status as NotificationStatus,
    attempts: Number(row.attempts),
    nextAttemptAt: text(row.next_attempt_at),
    ...(lastError === undefined ? {} : { lastError }),
    createdAt: text(row.created_at),
    ...(sentAt === undefined ? {} : { sentAt }),
  };
}

function mapLease(row: Row): ResourceLease {
  return {
    id: text(row.id),
    runId: text(row.run_id),
    resourceType: text(row.resource_type),
    resourceKey: text(row.resource_key),
    status: row.status as ResourceLease["status"],
    expiresAt: text(row.expires_at),
  };
}

export class SqliteStore {
  readonly db: DatabaseSync;
  private readonly clock: Clock;

  constructor(dbPath: string, clock: Clock = systemClock) {
    this.clock = clock;
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath, { timeout: 5000 });
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.applyMigrations();
  }

  private applyMigrations(): void {
    const bootstrap = migrations[0];
    if (!bootstrap) throw new Error("CAP migration list is empty");
    this.db.exec(bootstrap.sql);
    for (const migration of migrations) {
      const applied = this.db
        .prepare("SELECT version FROM schema_migrations WHERE version = ?")
        .get(migration.version);
      if (applied) continue;
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.exec(migration.sql);
        this.db
          .prepare(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
          )
          .run(migration.version, this.clock.now());
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
  }

  withTransaction<T>(callback: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  createProject(project: Project): Project {
    this.db
      .prepare(
        `INSERT INTO projects (id, name, repo_path, base_branch, config_path, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        project.id,
        project.name,
        project.repoPath,
        project.baseBranch,
        project.configPath,
        project.status,
        project.createdAt,
        project.updatedAt,
      );
    return project;
  }

  getProject(id: string): Project {
    const row = this.db
      .prepare("SELECT * FROM projects WHERE id = ?")
      .get(id) as Row | undefined;
    if (!row) throw new NotFoundError("project", id);
    return mapProject(row);
  }

  findProject(id: string): Project | undefined {
    const row = this.db
      .prepare("SELECT * FROM projects WHERE id = ?")
      .get(id) as Row | undefined;
    return row ? mapProject(row) : undefined;
  }

  listProjects(): Project[] {
    return (
      this.db.prepare("SELECT * FROM projects ORDER BY id").all() as Row[]
    ).map(mapProject);
  }

  createTask(task: Task): Task {
    this.db
      .prepare(
        `INSERT INTO tasks (id, project_id, title, status, risk_level, current_contract_version,
          last_submitted_commit, accepted_commit, failure_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.id,
        task.projectId,
        task.title,
        task.status,
        task.riskLevel,
        task.currentContractVersion ?? null,
        task.lastSubmittedCommit ?? null,
        task.acceptedCommit ?? null,
        task.failureCount,
        task.createdAt,
        task.updatedAt,
      );
    return task;
  }

  getTask(projectId: string, id: string): Task {
    const row = this.db
      .prepare("SELECT * FROM tasks WHERE project_id = ? AND id = ?")
      .get(projectId, id) as Row | undefined;
    if (!row) throw new NotFoundError("task", `${projectId}/${id}`);
    return mapTask(row);
  }

  findTask(projectId: string, id: string): Task | undefined {
    const row = this.db
      .prepare("SELECT * FROM tasks WHERE project_id = ? AND id = ?")
      .get(projectId, id) as Row | undefined;
    return row ? mapTask(row) : undefined;
  }

  updateTask(task: Task): Task {
    this.db
      .prepare(
        `UPDATE tasks SET title = ?, status = ?, risk_level = ?, current_contract_version = ?,
          last_submitted_commit = ?, accepted_commit = ?, failure_count = ?, updated_at = ?
         WHERE project_id = ? AND id = ?`,
      )
      .run(
        task.title,
        task.status,
        task.riskLevel,
        task.currentContractVersion ?? null,
        task.lastSubmittedCommit ?? null,
        task.acceptedCommit ?? null,
        task.failureCount,
        task.updatedAt,
        task.projectId,
        task.id,
      );
    return task;
  }

  createContract(contract: ContractRecord): ContractRecord {
    this.db
      .prepare(
        `INSERT INTO contracts (id, project_id, task_id, version, path, content_hash, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        contract.id,
        contract.projectId,
        contract.taskId,
        contract.version,
        contract.path,
        contract.contentHash,
        contract.status,
        contract.createdAt,
      );
    return contract;
  }

  findContract(
    projectId: string,
    taskId: string,
    version: string,
  ): ContractRecord | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM contracts WHERE project_id = ? AND task_id = ? AND version = ?",
      )
      .get(projectId, taskId, version) as Row | undefined;
    return row ? mapContract(row) : undefined;
  }

  createRequirements(requirements: RequirementRecord[]): void {
    const statement = this.db.prepare(
      `INSERT INTO requirements (id, contract_id, requirement_key, title, criticality,
        required_evidence_level, verification_modes_json, human_required)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const requirement of requirements) {
      statement.run(
        requirement.id,
        requirement.contractId,
        requirement.requirementKey,
        requirement.title,
        requirement.criticality,
        requirement.requiredEvidenceLevel,
        JSON.stringify(requirement.verificationModes),
        requirement.humanRequired ? 1 : 0,
      );
    }
  }

  listRequirements(contractId: string): RequirementRecord[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM requirements WHERE contract_id = ? ORDER BY requirement_key",
        )
        .all(contractId) as Row[]
    ).map(mapRequirement);
  }

  createRun(run: AcceptanceRun): AcceptanceRun {
    this.db
      .prepare(
        `INSERT INTO runs (id, project_id, task_id, target_commit, contract_version, test_data_version,
          gate_policy_version, idempotency_key, status, decision, reviewer_thread_id,
          trigger_source, execution_scope, attempt, retry_of, created_at, started_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.projectId,
        run.taskId,
        run.targetCommit,
        run.contractVersion,
        run.testDataVersion,
        run.gatePolicyVersion,
        run.idempotencyKey,
        run.status,
        run.decision ?? null,
        run.reviewerThreadId ?? null,
        run.triggerSource ?? "manual",
        run.executionScope ?? "local",
        run.attempt ?? 1,
        run.retryOf ?? null,
        run.createdAt,
        run.startedAt ?? null,
        run.completedAt ?? null,
      );
    return run;
  }

  getRun(id: string): AcceptanceRun {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as
      Row | undefined;
    if (!row) throw new NotFoundError("run", id);
    return mapRun(row);
  }

  findRunByIdempotencyKey(key: string): AcceptanceRun | undefined {
    const row = this.db
      .prepare("SELECT * FROM runs WHERE idempotency_key = ?")
      .get(key) as Row | undefined;
    return row ? mapRun(row) : undefined;
  }

  listRuns(projectId: string, taskId?: string): AcceptanceRun[] {
    const rows = taskId
      ? this.db
          .prepare(
            "SELECT * FROM runs WHERE project_id = ? AND task_id = ? ORDER BY created_at",
          )
          .all(projectId, taskId)
      : this.db
          .prepare(
            "SELECT * FROM runs WHERE project_id = ? ORDER BY created_at",
          )
          .all(projectId);
    return (rows as Row[]).map(mapRun);
  }

  updateRun(run: AcceptanceRun): AcceptanceRun {
    const current = this.getRun(run.id);
    const currentTriggerSource = current.triggerSource ?? "manual";
    const nextTriggerSource = run.triggerSource ?? "manual";
    const currentExecutionScope = current.executionScope ?? "local";
    const nextExecutionScope = run.executionScope ?? "local";
    const currentAttempt = current.attempt ?? 1;
    const nextAttempt = run.attempt ?? 1;
    if (
      current.projectId !== run.projectId ||
      current.taskId !== run.taskId ||
      current.targetCommit !== run.targetCommit ||
      current.contractVersion !== run.contractVersion ||
      current.testDataVersion !== run.testDataVersion ||
      current.gatePolicyVersion !== run.gatePolicyVersion ||
      current.idempotencyKey !== run.idempotencyKey ||
      currentTriggerSource !== nextTriggerSource ||
      currentExecutionScope !== nextExecutionScope ||
      currentAttempt !== nextAttempt ||
      current.retryOf !== run.retryOf ||
      current.createdAt !== run.createdAt
    ) {
      throw new ImmutableRunError(
        `Immutable run fields cannot change for ${run.id}`,
      );
    }
    this.db
      .prepare(
        `UPDATE runs SET status = ?, decision = ?, reviewer_thread_id = ?, started_at = ?, completed_at = ?
         WHERE id = ?`,
      )
      .run(
        run.status,
        run.decision ?? null,
        run.reviewerThreadId ?? null,
        run.startedAt ?? null,
        run.completedAt ?? null,
        run.id,
      );
    return run;
  }

  appendEvent(
    runId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): RunEvent {
    const row = this.db
      .prepare(
        "SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM run_events WHERE run_id = ?",
      )
      .get(runId) as Row;
    const sequence = Number(row.next_sequence);
    const createdAt = this.clock.now();
    const result = this.db
      .prepare(
        `INSERT INTO run_events (run_id, sequence, event_type, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(runId, sequence, eventType, JSON.stringify(payload), createdAt);
    return {
      id: Number(result.lastInsertRowid),
      runId,
      sequence,
      eventType,
      payload,
      createdAt,
    };
  }

  listEvents(runId: string): RunEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM run_events WHERE run_id = ? ORDER BY sequence")
      .all(runId) as Row[];
    return rows.map((row) => ({
      id: Number(row.id),
      runId: text(row.run_id),
      sequence: Number(row.sequence),
      eventType: text(row.event_type),
      payload: JSON.parse(text(row.payload_json)) as Record<string, unknown>,
      createdAt: text(row.created_at),
    }));
  }

  createAutomationJob(job: AutomationJob): AutomationJob {
    this.db
      .prepare(
        `INSERT INTO automation_jobs (
          id, project_id, task_id, run_id, source, execution_scope, event_id,
          idempotency_key, status, attempts, max_attempts, lease_owner,
          lease_expires_at, next_attempt_at, last_error, created_at, updated_at,
          started_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        job.id,
        job.projectId,
        job.taskId,
        job.runId ?? null,
        job.source,
        job.executionScope,
        job.eventId,
        job.idempotencyKey,
        job.status,
        job.attempts,
        job.maxAttempts,
        job.leaseOwner ?? null,
        job.leaseExpiresAt ?? null,
        job.nextAttemptAt,
        job.lastError ?? null,
        job.createdAt,
        job.updatedAt,
        job.startedAt ?? null,
        job.completedAt ?? null,
      );
    return job;
  }

  getAutomationJob(id: string): AutomationJob {
    const row = this.db
      .prepare("SELECT * FROM automation_jobs WHERE id = ?")
      .get(id) as Row | undefined;
    if (!row) throw new NotFoundError("automation job", id);
    return mapAutomationJob(row);
  }

  findAutomationJobByIdempotencyKey(
    idempotencyKey: string,
  ): AutomationJob | undefined {
    const row = this.db
      .prepare("SELECT * FROM automation_jobs WHERE idempotency_key = ?")
      .get(idempotencyKey) as Row | undefined;
    return row ? mapAutomationJob(row) : undefined;
  }

  findAutomationJobByEvent(
    executionScope: AutomationJob["executionScope"],
    eventId: string,
  ): AutomationJob | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM automation_jobs WHERE execution_scope = ? AND event_id = ?",
      )
      .get(executionScope, eventId) as Row | undefined;
    return row ? mapAutomationJob(row) : undefined;
  }

  findAutomationJobByRunId(runId: string): AutomationJob | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM automation_jobs WHERE run_id = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(runId) as Row | undefined;
    if (row) return mapAutomationJob(row);
    const lineage = this.db
      .prepare(
        `WITH RECURSIVE run_lineage(id) AS (
           SELECT ?
           UNION ALL
           SELECT runs.id FROM runs JOIN run_lineage ON runs.retry_of = run_lineage.id
         )
         SELECT automation_jobs.*
         FROM automation_jobs
         WHERE automation_jobs.run_id IN (SELECT id FROM run_lineage)
         ORDER BY automation_jobs.created_at DESC LIMIT 1`,
      )
      .get(runId) as Row | undefined;
    return lineage ? mapAutomationJob(lineage) : undefined;
  }

  listAutomationJobs(projectId?: string): AutomationJob[] {
    const rows = projectId
      ? this.db
          .prepare(
            "SELECT * FROM automation_jobs WHERE project_id = ? ORDER BY created_at",
          )
          .all(projectId)
      : this.db
          .prepare("SELECT * FROM automation_jobs ORDER BY created_at")
          .all();
    return (rows as Row[]).map(mapAutomationJob);
  }

  updateAutomationJob(job: AutomationJob): AutomationJob {
    const current = this.getAutomationJob(job.id);
    if (
      current.projectId !== job.projectId ||
      current.taskId !== job.taskId ||
      current.source !== job.source ||
      current.executionScope !== job.executionScope ||
      current.eventId !== job.eventId ||
      current.idempotencyKey !== job.idempotencyKey ||
      current.createdAt !== job.createdAt
    ) {
      throw new Error(
        `Immutable automation job fields cannot change for ${job.id}`,
      );
    }
    this.db
      .prepare(
        `UPDATE automation_jobs SET run_id = ?, status = ?, attempts = ?, max_attempts = ?,
          lease_owner = ?, lease_expires_at = ?, next_attempt_at = ?, last_error = ?,
          updated_at = ?, started_at = ?, completed_at = ? WHERE id = ?`,
      )
      .run(
        job.runId ?? null,
        job.status,
        job.attempts,
        job.maxAttempts,
        job.leaseOwner ?? null,
        job.leaseExpiresAt ?? null,
        job.nextAttemptAt,
        job.lastError ?? null,
        job.updatedAt,
        job.startedAt ?? null,
        job.completedAt ?? null,
        job.id,
      );
    return job;
  }

  claimNextAutomationJob(
    owner: string,
    leaseExpiresAt: string,
    now: string,
  ): AutomationJob | undefined {
    return this.withTransaction(() => {
      this.db
        .prepare(
          `UPDATE automation_jobs SET status = 'QUEUED', lease_owner = NULL,
            lease_expires_at = NULL, updated_at = ?
           WHERE status IN ('CLAIMED', 'RUNNING')
             AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`,
        )
        .run(now, now);
      const row = this.db
        .prepare(
          `SELECT * FROM automation_jobs
           WHERE status IN ('QUEUED', 'RETRY_WAIT') AND next_attempt_at <= ?
           ORDER BY created_at LIMIT 1`,
        )
        .get(now) as Row | undefined;
      if (!row) return undefined;
      const job = mapAutomationJob(row);
      const claimed: AutomationJob = {
        ...job,
        status: "CLAIMED",
        attempts: job.attempts + 1,
        leaseOwner: owner,
        leaseExpiresAt,
        updatedAt: now,
        startedAt: job.startedAt ?? now,
      };
      this.updateAutomationJob(claimed);
      return claimed;
    });
  }

  renewAutomationJobLease(
    jobId: string,
    owner: string,
    leaseExpiresAt: string,
    now: string,
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE automation_jobs SET lease_expires_at = ?, updated_at = ?
         WHERE id = ? AND lease_owner = ? AND status IN ('CLAIMED', 'RUNNING')`,
      )
      .run(leaseExpiresAt, now, jobId, owner);
    return Number(result.changes) === 1;
  }

  createNotificationOutbox(
    item: NotificationOutboxItem,
  ): NotificationOutboxItem {
    this.db
      .prepare(
        `INSERT INTO notification_outbox (
          id, run_id, job_id, event_type, dedupe_key, payload_json, status,
          attempts, next_attempt_at, last_error, created_at, sent_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        item.id,
        item.runId ?? null,
        item.jobId ?? null,
        item.eventType,
        item.dedupeKey,
        JSON.stringify(item.payload),
        item.status,
        item.attempts,
        item.nextAttemptAt,
        item.lastError ?? null,
        item.createdAt,
        item.sentAt ?? null,
      );
    return item;
  }

  getNotificationOutbox(id: string): NotificationOutboxItem {
    const row = this.db
      .prepare("SELECT * FROM notification_outbox WHERE id = ?")
      .get(id) as Row | undefined;
    if (!row) throw new NotFoundError("notification outbox item", id);
    return mapNotificationOutbox(row);
  }

  findNotificationOutboxByDedupeKey(
    dedupeKey: string,
  ): NotificationOutboxItem | undefined {
    const row = this.db
      .prepare("SELECT * FROM notification_outbox WHERE dedupe_key = ?")
      .get(dedupeKey) as Row | undefined;
    return row ? mapNotificationOutbox(row) : undefined;
  }

  listNotificationOutbox(
    statuses: NotificationStatus[] = ["PENDING", "FAILED"],
  ): NotificationOutboxItem[] {
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT * FROM notification_outbox WHERE status IN (${placeholders})
         ORDER BY created_at`,
      )
      .all(...statuses);
    return (rows as Row[]).map(mapNotificationOutbox);
  }

  updateNotificationOutbox(
    item: NotificationOutboxItem,
  ): NotificationOutboxItem {
    this.db
      .prepare(
        `UPDATE notification_outbox SET status = ?, attempts = ?, next_attempt_at = ?,
          last_error = ?, sent_at = ? WHERE id = ?`,
      )
      .run(
        item.status,
        item.attempts,
        item.nextAttemptAt,
        item.lastError ?? null,
        item.sentAt ?? null,
        item.id,
      );
    return item;
  }

  createNotificationDelivery(
    delivery: NotificationDelivery,
  ): NotificationDelivery {
    this.db
      .prepare(
        `INSERT INTO notification_deliveries (
          id, outbox_id, channel, status, attempts, next_attempt_at,
          last_error, created_at, sent_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        delivery.id,
        delivery.outboxId,
        delivery.channel,
        delivery.status,
        delivery.attempts,
        delivery.nextAttemptAt,
        delivery.lastError ?? null,
        delivery.createdAt,
        delivery.sentAt ?? null,
      );
    return delivery;
  }

  findNotificationDelivery(
    outboxId: string,
    channel: string,
  ): NotificationDelivery | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM notification_deliveries WHERE outbox_id = ? AND channel = ?",
      )
      .get(outboxId, channel) as Row | undefined;
    return row ? mapNotificationDelivery(row) : undefined;
  }

  updateNotificationDelivery(
    delivery: NotificationDelivery,
  ): NotificationDelivery {
    this.db
      .prepare(
        `UPDATE notification_deliveries SET status = ?, attempts = ?, next_attempt_at = ?,
          last_error = ?, sent_at = ? WHERE id = ?`,
      )
      .run(
        delivery.status,
        delivery.attempts,
        delivery.nextAttemptAt,
        delivery.lastError ?? null,
        delivery.sentAt ?? null,
        delivery.id,
      );
    return delivery;
  }

  listNotificationDeliveries(outboxId: string): NotificationDelivery[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM notification_deliveries WHERE outbox_id = ? ORDER BY channel",
        )
        .all(outboxId) as Row[]
    ).map(mapNotificationDelivery);
  }

  createLease(lease: ResourceLease): ResourceLease {
    this.db
      .prepare(
        `INSERT INTO resource_leases (id, run_id, resource_type, resource_key, status, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        lease.id,
        lease.runId,
        lease.resourceType,
        lease.resourceKey,
        lease.status,
        lease.expiresAt,
      );
    return lease;
  }

  findActiveLease(
    resourceType: string,
    resourceKey: string,
  ): ResourceLease | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM resource_leases
         WHERE resource_type = ? AND resource_key = ? AND status = 'ACTIVE'`,
      )
      .get(resourceType, resourceKey) as Row | undefined;
    return row ? mapLease(row) : undefined;
  }

  listLeases(runId: string): ResourceLease[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM resource_leases WHERE run_id = ? ORDER BY resource_type, resource_key",
        )
        .all(runId) as Row[]
    ).map(mapLease);
  }

  releaseLease(
    id: string,
    status: ResourceLease["status"] = "RELEASED",
  ): ResourceLease {
    const row = this.db
      .prepare("SELECT * FROM resource_leases WHERE id = ?")
      .get(id) as Row | undefined;
    if (!row) throw new NotFoundError("resource lease", id);
    this.db
      .prepare("UPDATE resource_leases SET status = ? WHERE id = ?")
      .run(status, id);
    return mapLease({ ...row, status });
  }
}
