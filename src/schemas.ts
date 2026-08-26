export type SchemaName =
  | "project"
  | "acceptance-contract"
  | "handoff"
  | "run-manifest"
  | "verifier-result"
  | "reviewer-report"
  | "acceptance-matrix"
  | "failure-package"
  | "human-request"
  | "gate-decision"
  | "visual-case";

const versionOne = { const: 1 };

const requirement = {
  type: "object",
  required: ["id", "title", "criticality", "verification"],
  properties: {
    id: { type: "string", minLength: 1 },
    title: { type: "string", minLength: 1 },
    criticality: { enum: ["core", "major", "minor"] },
    verification: {
      type: "object",
      required: ["modes", "required_evidence"],
      properties: {
        modes: { type: "array", items: { type: "string" }, minItems: 1 },
        required_evidence: { enum: ["E0", "E1", "E2", "E3", "E4", "E5"] },
      },
      additionalProperties: true,
    },
    expected: { type: "array", items: { type: "string" } },
    human_required: { type: "boolean" },
  },
  additionalProperties: true,
};

export const capSchemas: Record<SchemaName, object> = {
  project: {
    $id: "cap://schemas/project.schema.json",
    type: "object",
    required: ["version", "project_id", "display_name", "repository"],
    properties: {
      version: versionOne,
      project_id: {
        type: "string",
        pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]{1,63}$",
      },
      display_name: { type: "string", minLength: 1 },
      repository: {
        type: "object",
        required: ["base_branch"],
        properties: {
          base_branch: { type: "string", minLength: 1 },
          require_clean_submission: { type: "boolean" },
          submodules: { type: "boolean" },
        },
        additionalProperties: true,
      },
    },
    additionalProperties: true,
  },
  "acceptance-contract": {
    $id: "cap://schemas/acceptance-contract.schema.json",
    type: "object",
    required: ["version", "contract_id", "task_id", "title", "requirements"],
    properties: {
      version: versionOne,
      contract_id: { type: "string", minLength: 1 },
      task_id: { type: "string", minLength: 1 },
      title: { type: "string", minLength: 1 },
      risk_level: { enum: ["R0", "R1", "R2", "R3"] },
      spec_version: { type: "string" },
      requirements: { type: "array", minItems: 1, items: requirement },
      scenarios: {
        type: "array",
        items: {
          type: "object",
          required: ["id", "fixture"],
          properties: { id: { type: "string" }, fixture: { type: "string" } },
          additionalProperties: true,
        },
      },
      human_required: { type: "boolean" },
    },
    additionalProperties: true,
  },
  handoff: {
    type: "object",
    required: [
      "version",
      "project_id",
      "task_id",
      "target_commit",
      "contract_id",
    ],
    properties: {
      version: versionOne,
      project_id: { type: "string", minLength: 1 },
      task_id: { type: "string", minLength: 1 },
      target_commit: { type: "string", pattern: "^[0-9a-fA-F]{7,64}$" },
      contract_id: { type: "string", minLength: 1 },
    },
    additionalProperties: true,
  },
  "run-manifest": {
    type: "object",
    required: [
      "version",
      "run_id",
      "project_id",
      "task_id",
      "target_commit",
      "contract_version",
      "test_data_version",
      "gate_policy_version",
      "created_at",
      "immutable",
    ],
    properties: {
      version: versionOne,
      run_id: { type: "string" },
      project_id: { type: "string" },
      task_id: { type: "string" },
      target_commit: { type: "string", minLength: 7 },
      contract_version: { type: "string", minLength: 1 },
      test_data_version: { type: "string", minLength: 1 },
      gate_policy_version: { type: "string", minLength: 1 },
      created_at: { type: "string" },
      immutable: { const: true },
    },
    additionalProperties: true,
  },
  "verifier-result": {
    type: "object",
    required: [
      "version",
      "run_id",
      "verifier",
      "result",
      "started_at",
      "completed_at",
      "exit_code",
      "evidence",
    ],
    properties: {
      version: versionOne,
      run_id: { type: "string" },
      verifier: { type: "string" },
      result: { enum: ["PASS", "FAIL", "BLOCKED", "NOT_TESTED"] },
      started_at: { type: "string" },
      completed_at: { type: "string" },
      exit_code: { type: ["integer", "null"] },
      evidence: { type: "array" },
    },
    additionalProperties: true,
  },
  "reviewer-report": {
    type: "object",
    required: [
      "version",
      "run_id",
      "target_commit",
      "reviewer_verdict",
      "requirement_results",
    ],
    properties: {
      version: versionOne,
      run_id: { type: "string" },
      target_commit: { type: "string" },
      reviewer_verdict: { enum: ["PASS", "FAIL", "HUMAN", "NOT_TESTED"] },
      requirement_results: { type: "array" },
    },
    additionalProperties: true,
  },
  "acceptance-matrix": {
    type: "object",
    required: ["version", "run_id", "requirements"],
    properties: {
      version: versionOne,
      run_id: { type: "string" },
      requirements: { type: "array" },
    },
    additionalProperties: true,
  },
  "failure-package": {
    type: "object",
    required: [
      "version",
      "run_id",
      "target_commit",
      "task_id",
      "decision",
      "failures",
      "required_retests",
    ],
    properties: {
      version: versionOne,
      run_id: { type: "string" },
      target_commit: { type: "string" },
      task_id: { type: "string" },
      decision: { const: "FAIL" },
      failures: { type: "array" },
      required_retests: { type: "array" },
    },
    additionalProperties: true,
  },
  "human-request": {
    type: "object",
    required: ["version", "run_id", "reason", "question", "options", "risk"],
    properties: {
      version: versionOne,
      run_id: { type: "string" },
      reason: { type: "string" },
      question: { type: "string" },
      options: { type: "array", minItems: 2 },
      risk: { type: "string" },
    },
    additionalProperties: true,
  },
  "gate-decision": {
    type: "object",
    required: [
      "version",
      "run_id",
      "decision",
      "reason_codes",
      "policy_version",
      "created_at",
    ],
    properties: {
      version: versionOne,
      run_id: { type: "string" },
      decision: { enum: ["PASS", "FAIL", "HUMAN"] },
      reason_codes: { type: "array" },
      policy_version: { type: "string" },
      created_at: { type: "string" },
    },
    additionalProperties: true,
  },
  "visual-case": {
    type: "object",
    required: ["version", "case_id", "route", "states", "viewports"],
    properties: {
      version: versionOne,
      case_id: { type: "string" },
      route: { type: "string" },
      states: { type: "array", minItems: 1 },
      viewports: { type: "array", minItems: 1 },
    },
    additionalProperties: true,
  },
};
