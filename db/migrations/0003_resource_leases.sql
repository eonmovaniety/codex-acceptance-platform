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

