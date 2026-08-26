export const taskStatuses = [
  "BUILDING",
  "READY_FOR_REVIEW",
  "IN_ACCEPTANCE",
  "ACCEPTED",
  "FIX_REQUESTED",
  "FIXING",
  "NEEDS_HUMAN",
  "BLOCKED",
  "CANCELLED",
] as const;

export type TaskStatus = (typeof taskStatuses)[number];

export const runStatuses = [
  "CREATED",
  "VALIDATING",
  "PREPARING",
  "INVALID",
  "VERIFYING",
  "REVIEWING",
  "GATING",
  "INFRA_FAILED",
  "COMPLETED_PASS",
  "COMPLETED_FAIL",
  "COMPLETED_HUMAN",
  "CANCELLED",
] as const;

export type RunStatus = (typeof runStatuses)[number];
export type RunDecision = "PASS" | "FAIL" | "HUMAN";
export type RiskLevel = "R0" | "R1" | "R2" | "R3";
export type Criticality = "core" | "major" | "minor";
export type EvidenceLevel = "E0" | "E1" | "E2" | "E3" | "E4" | "E5";

export interface ProjectConfig {
  version: 1;
  project_id: string;
  display_name: string;
  repository: {
    base_branch: string;
    require_clean_submission?: boolean;
    submodules?: boolean;
  };
  adapter?: {
    type: string;
    config?: Record<string, unknown>;
  };
  commands?: {
    setup?: string[];
    build?: string[];
    lint?: string[];
    unit?: string[];
    integration?: string[];
    e2e?: string[];
  };
  runtime?: {
    isolation?: "same" | "named" | "container" | "vm";
    network_default?: "disabled" | "enabled";
    timeout_seconds?: number;
    env_allowlist?: string[];
  };
  test_data?: {
    version: string;
    reset_command?: string;
    seed_command?: string;
    destroy_command?: string;
  };
  reviewer?: {
    provider?: "fake" | "codex" | string;
    mode?: "exec" | "review" | string;
    fresh_thread_per_run?: boolean;
    sandbox?: "read-only" | "workspace-write" | string;
    network?: "disabled" | "enabled" | string;
    skill?: string;
    max_turns?: number;
    retain_session_on?: string[];
  };
  visual?: {
    enabled?: boolean;
    policy?: string;
  };
  gate?: {
    policy?: string;
    policy_version?: string;
  };
  human_gates?: string[];
}

export interface ContractRequirement {
  id: string;
  title: string;
  criticality: Criticality;
  verification: {
    modes: string[];
    required_evidence: EvidenceLevel;
  };
  expected?: string[];
  human_required?: boolean;
}

export interface AcceptanceContract {
  version: 1;
  contract_id: string;
  task_id: string;
  title: string;
  risk_level?: RiskLevel;
  spec_version?: string;
  requirements: ContractRequirement[];
  scenarios?: Array<{
    id: string;
    fixture: string;
  }>;
  human_required?: boolean;
}

export interface Project {
  id: string;
  name: string;
  repoPath: string;
  baseBranch: string;
  configPath: string;
  status: "ACTIVE" | "PAUSED";
  createdAt: string;
  updatedAt: string;
}

export interface Task {
  id: string;
  projectId: string;
  title: string;
  status: TaskStatus;
  riskLevel: RiskLevel;
  currentContractVersion?: string;
  lastSubmittedCommit?: string;
  acceptedCommit?: string;
  failureCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ContractRecord {
  id: string;
  projectId: string;
  taskId: string;
  version: string;
  path: string;
  contentHash: string;
  status: "DRAFT" | "ACTIVE" | "SUPERSEDED";
  createdAt: string;
}

export interface RequirementRecord {
  id: string;
  contractId: string;
  requirementKey: string;
  title: string;
  criticality: Criticality;
  requiredEvidenceLevel: EvidenceLevel;
  verificationModes: string[];
  humanRequired: boolean;
}

export interface AcceptanceRun {
  id: string;
  projectId: string;
  taskId: string;
  targetCommit: string;
  contractVersion: string;
  testDataVersion: string;
  gatePolicyVersion: string;
  idempotencyKey: string;
  status: RunStatus;
  decision?: RunDecision;
  reviewerThreadId?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface RunEvent {
  id: number;
  runId: string;
  sequence: number;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface ResourceLease {
  id: string;
  runId: string;
  resourceType: string;
  resourceKey: string;
  status: "ACTIVE" | "RELEASED" | "EXPIRED";
  expiresAt: string;
}

export interface SubmitResult {
  run: AcceptanceRun;
  existing: boolean;
}
