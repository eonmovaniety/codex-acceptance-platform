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
