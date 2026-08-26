export type SchemaName =
  | "project"
  | "acceptance-contract"
  | "handoff"
  | "run-manifest"
  | "verifier-result"
  | "reviewer-report"
  | "evidence-index"
  | "acceptance-matrix"
  | "failure-package"
  | "fix-request"
  | "impact-analysis"
  | "human-request"
  | "baseline-request"
  | "test-data-manifest"
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

const reviewerFinding = {
  type: "object",
  required: [
    "id",
    "requirement_id",
    "severity",
    "title",
    "description",
    "evidence_paths",
  ],
  properties: {
    id: { type: "string", minLength: 1 },
    requirement_id: { type: "string", minLength: 1 },
    severity: { enum: ["S0", "S1", "S2", "S3", "S4"] },
    title: { type: "string", minLength: 1 },
    description: { type: "string", minLength: 1 },
    expected: { type: "string" },
    observed: { type: "string" },
    reproduction: { type: "array", items: { type: "string" } },
    evidence_paths: { type: "array", items: { type: "string" } },
  },
  additionalProperties: true,
};

const reviewerRequirementResult = {
  type: "object",
  required: [
    "requirement_id",
    "result",
    "evidence_level",
    "evidence_paths",
    "finding_ids",
  ],
  properties: {
    requirement_id: { type: "string", minLength: 1 },
    result: {
      enum: ["PASS", "FAIL", "NOT_TESTED", "BLOCKED", "NOT_APPLICABLE"],
    },
    evidence_level: { enum: ["E0", "E1", "E2", "E3", "E4", "E5"] },
    evidence_paths: { type: "array", items: { type: "string" } },
    severity: { enum: ["S0", "S1", "S2", "S3", "S4"] },
    finding_ids: { type: "array", items: { type: "string" } },
    expected: { type: "string" },
    observed: { type: "string" },
    reproduction: { type: "array", items: { type: "string" } },
    notes: { type: "array", items: { type: "string" } },
  },
  additionalProperties: true,
};

const reviewerHumanRequest = {
  type: "object",
  required: ["id", "reason", "question", "options", "risk"],
  properties: {
    id: { type: "string", minLength: 1 },
    reason: { type: "string", minLength: 1 },
    question: { type: "string", minLength: 1 },
    options: { type: "array", items: { type: "string" }, minItems: 2 },
    risk: { type: "string", minLength: 1 },
  },
  additionalProperties: true,
};

const evidenceRecord = {
  type: "object",
  required: ["id", "run_id", "source", "kind", "path", "level", "exists"],
  properties: {
    id: { type: "string", minLength: 1 },
    run_id: { type: "string", minLength: 1 },
    requirement_id: { type: "string" },
    source: { enum: ["verifier", "reviewer", "system", "human"] },
    kind: { type: "string", minLength: 1 },
    path: { type: "string", minLength: 1 },
    level: { enum: ["E0", "E1", "E2", "E3", "E4", "E5"] },
    exists: { type: "boolean" },
    description: { type: "string" },
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
      "findings",
      "requested_human_decisions",
      "requested_probes",
      "notes",
    ],
    properties: {
      version: versionOne,
      run_id: { type: "string" },
      target_commit: { type: "string" },
      reviewer_verdict: { enum: ["PASS", "FAIL", "HUMAN", "NOT_TESTED"] },
      requirement_results: {
        type: "array",
        items: reviewerRequirementResult,
      },
      findings: { type: "array", items: reviewerFinding },
      requested_human_decisions: {
        type: "array",
        items: reviewerHumanRequest,
      },
      requested_probes: { type: "array", items: { type: "string" } },
      notes: { type: "array", items: { type: "string" } },
    },
    additionalProperties: true,
  },
  "evidence-index": {
    type: "object",
    required: ["version", "run_id", "records"],
    properties: {
      version: versionOne,
      run_id: { type: "string", minLength: 1 },
      records: { type: "array", items: evidenceRecord },
    },
    additionalProperties: true,
  },
  "acceptance-matrix": {
    type: "object",
    required: ["version", "run_id", "requirements"],
    properties: {
      version: versionOne,
      run_id: { type: "string" },
      requirements: {
        type: "array",
        items: {
          type: "object",
          required: [
            "id",
            "title",
            "criticality",
            "result",
            "required_evidence",
            "actual_evidence",
            "artifacts",
            "evidence_valid",
            "finding_ids",
            "human_required",
          ],
          properties: {
            id: { type: "string", minLength: 1 },
            title: { type: "string", minLength: 1 },
            criticality: { enum: ["core", "major", "minor"] },
            result: {
              enum: ["PASS", "FAIL", "NOT_TESTED", "BLOCKED", "NOT_APPLICABLE"],
            },
            required_evidence: {
              enum: ["E0", "E1", "E2", "E3", "E4", "E5"],
            },
            actual_evidence: {
              enum: ["E0", "E1", "E2", "E3", "E4", "E5"],
            },
            artifacts: { type: "array", items: { type: "string" } },
            evidence_valid: { type: "boolean" },
            severity: { enum: ["S0", "S1", "S2", "S3", "S4"] },
            finding_ids: { type: "array", items: { type: "string" } },
            human_required: { type: "boolean" },
          },
          additionalProperties: true,
        },
      },
      coverage: {
        type: "object",
        required: [
          "total",
          "pass",
          "fail",
          "not_tested",
          "blocked",
          "not_applicable",
        ],
        properties: {
          total: { type: "integer", minimum: 0 },
          pass: { type: "integer", minimum: 0 },
          fail: { type: "integer", minimum: 0 },
          not_tested: { type: "integer", minimum: 0 },
          blocked: { type: "integer", minimum: 0 },
          not_applicable: { type: "integer", minimum: 0 },
        },
        additionalProperties: true,
      },
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
      failures: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          required: [
            "finding_id",
            "requirement_id",
            "severity",
            "expected",
            "observed",
            "reproduction",
            "evidence",
            "suspected_areas",
            "regression_risks",
            "failure_class",
          ],
          properties: {
            finding_id: { type: "string", minLength: 1 },
            requirement_id: { type: "string", minLength: 1 },
            severity: { enum: ["S0", "S1", "S2", "S3", "S4"] },
            expected: { type: "string", minLength: 1 },
            observed: { type: "string", minLength: 1 },
            reproduction: {
              type: "array",
              items: { type: "string" },
              minItems: 1,
            },
            evidence: { type: "array", items: { type: "string" } },
            suspected_areas: { type: "array", items: { type: "string" } },
            regression_risks: { type: "array", items: { type: "string" } },
            failure_class: {
              enum: [
                "IMPLEMENTATION_FAIL",
                "TEST_INFRA_FAIL",
                "SPEC_BLOCKED",
                "ENVIRONMENT_BLOCKED",
                "BASELINE_INVALID",
                "SECURITY_RISK",
                "REVIEWER_CONFLICT",
              ],
            },
          },
          additionalProperties: true,
        },
      },
      required_retests: {
        type: "array",
        items: { type: "string", minLength: 1 },
        minItems: 1,
      },
    },
    additionalProperties: true,
  },
  "fix-request": {
    type: "object",
    required: [
      "version",
      "request_id",
      "task_id",
      "source_run_id",
      "source_commit",
      "status",
      "failure_package_path",
      "required_retests",
      "escalation_level",
      "attempt",
      "created_at",
      "updated_at",
    ],
    properties: {
      version: versionOne,
      request_id: { type: "string", minLength: 1 },
      task_id: { type: "string", minLength: 1 },
      source_run_id: { type: "string", minLength: 1 },
      source_commit: { type: "string", minLength: 7 },
      status: {
        enum: [
          "OPEN",
          "IN_PROGRESS",
          "RESOLVED",
          "ESCALATED",
          "HUMAN_REQUIRED",
        ],
      },
      failure_package_path: { type: "string", minLength: 1 },
      required_retests: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
      },
      escalation_level: {
        enum: [
          "AUTO_FIX",
          "ROOT_CAUSE_REVIEW",
          "ARCHITECTURE_REVIEW",
          "HUMAN_REQUIRED",
        ],
      },
      attempt: { type: "integer", minimum: 1 },
      created_at: { type: "string", minLength: 1 },
      updated_at: { type: "string", minLength: 1 },
    },
    additionalProperties: true,
  },
  "impact-analysis": {
    type: "object",
    required: [
      "version",
      "run_id",
      "changed_files",
      "impacted_requirement_ids",
      "selected_retests",
      "reason",
    ],
    properties: {
      version: versionOne,
      run_id: { type: "string", minLength: 1 },
      changed_files: { type: "array", items: { type: "string" } },
      impacted_requirement_ids: { type: "array", items: { type: "string" } },
      selected_retests: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
      },
      reason: { type: "string", minLength: 1 },
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
  "baseline-request": {
    type: "object",
    required: [
      "version",
      "request_id",
      "project_id",
      "case_id",
      "state",
      "viewport_id",
      "reason",
      "candidate_artifact",
      "baseline_path",
      "width",
      "height",
      "status",
      "created_at",
      "updated_at",
    ],
    properties: {
      version: versionOne,
      request_id: { type: "string", minLength: 1 },
      project_id: { type: "string", minLength: 1 },
      case_id: { type: "string", minLength: 1 },
      state: { type: "string", minLength: 1 },
      viewport_id: { type: "string", minLength: 1 },
      reason: { enum: ["MISSING_BASELINE", "BASELINE_CHANGE"] },
      candidate_artifact: { type: "string", minLength: 1 },
      baseline_path: { type: "string", minLength: 1 },
      width: { type: "integer", minimum: 1 },
      height: { type: "integer", minimum: 1 },
      status: { enum: ["PENDING", "APPROVED", "REJECTED"] },
      created_at: { type: "string", minLength: 1 },
      updated_at: { type: "string", minLength: 1 },
    },
    additionalProperties: true,
  },
  "test-data-manifest": {
    type: "object",
    required: [
      "version",
      "run_id",
      "data_version",
      "root",
      "layers",
      "fresh_database",
      "stages",
      "marker_path",
    ],
    properties: {
      version: versionOne,
      run_id: { type: "string", minLength: 1 },
      data_version: { type: "string", minLength: 1 },
      root: { type: "string", minLength: 1 },
      layers: { type: "array", minItems: 4 },
      fresh_database: { type: "boolean" },
      stages: { type: "array" },
      marker_path: { type: "string", minLength: 1 },
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
      reason_codes: { type: "array", items: { type: "string" }, minItems: 1 },
      policy_version: { type: "string" },
      created_at: { type: "string" },
      details: { type: "object" },
    },
    additionalProperties: true,
  },
  "visual-case": {
    type: "object",
    required: ["version", "case_id", "route", "states", "viewports"],
    properties: {
      version: versionOne,
      case_id: { type: "string", minLength: 1 },
      route: { type: "string" },
      states: {
        type: "array",
        minItems: 1,
        items: { type: "string", minLength: 1 },
      },
      viewports: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          required: ["id", "width", "height"],
          properties: {
            id: { type: "string", minLength: 1 },
            width: { type: "integer", minimum: 1 },
            height: { type: "integer", minimum: 1 },
            dpr: { type: "number", exclusiveMinimum: 0 },
          },
          additionalProperties: true,
        },
      },
    },
    additionalProperties: true,
  },
};
