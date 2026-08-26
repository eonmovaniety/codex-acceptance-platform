import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AcceptanceRun,
  ContractRecord,
  Project,
  RequirementRecord,
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
    createdAt: text(row.created_at),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(completedAt === undefined ? {} : { completedAt }),
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
          gate_policy_version, idempotency_key, status, decision, reviewer_thread_id, created_at, started_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    if (
      current.projectId !== run.projectId ||
      current.taskId !== run.taskId ||
      current.targetCommit !== run.targetCommit ||
      current.contractVersion !== run.contractVersion ||
      current.testDataVersion !== run.testDataVersion ||
      current.gatePolicyVersion !== run.gatePolicyVersion ||
      current.idempotencyKey !== run.idempotencyKey ||
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
}
