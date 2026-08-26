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

