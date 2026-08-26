import { randomUUID } from "node:crypto";
import type { AcceptanceContract, AcceptanceRun, Task } from "./domain.js";
import type { ArtifactStore } from "./artifacts.js";
import { CapError } from "./errors.js";
import type { GateDecision } from "./gate.js";
import type { AcceptanceMatrix, MatrixRequirement } from "./matrix.js";
import type { ReviewerReport, Severity } from "./review.js";
import { validateDocument } from "./validation.js";

export type FailureClass =
  | "IMPLEMENTATION_FAIL"
  | "TEST_INFRA_FAIL"
  | "SPEC_BLOCKED"
  | "ENVIRONMENT_BLOCKED"
  | "BASELINE_INVALID"
  | "SECURITY_RISK"
  | "REVIEWER_CONFLICT";

export interface FailureItem {
  finding_id: string;
  requirement_id: string;
  severity: Severity;
  expected: string;
  observed: string;
  reproduction: string[];
  evidence: string[];
  suspected_areas: string[];
  regression_risks: string[];
  failure_class: FailureClass;
}

export interface FailurePackage {
  version: 1;
  run_id: string;
  target_commit: string;
  task_id: string;
  decision: "FAIL";
  failures: FailureItem[];
  required_retests: string[];
}

export type FixRequestStatus =
  "OPEN" | "IN_PROGRESS" | "RESOLVED" | "ESCALATED" | "HUMAN_REQUIRED";

export interface FixRequest {
  version: 1;
  request_id: string;
  task_id: string;
  source_run_id: string;
  source_commit: string;
  status: FixRequestStatus;
  failure_package_path: string;
  required_retests: string[];
  escalation_level: EscalationLevel;
  attempt: number;
  created_at: string;
  updated_at: string;
}

export type EscalationLevel =
  "AUTO_FIX" | "ROOT_CAUSE_REVIEW" | "ARCHITECTURE_REVIEW" | "HUMAN_REQUIRED";

export interface ImpactAnalysis {
  version: 1;
  run_id: string;
  changed_files: string[];
  impacted_requirement_ids: string[];
  selected_retests: string[];
  reason: string;
}

export interface FailurePackageInput {
  run: AcceptanceRun;
  task: Task;
  contract: AcceptanceContract;
  matrix: AcceptanceMatrix;
  report: ReviewerReport;
  gate: GateDecision;
  now?: () => string;
  failureClass?: FailureClass;
}

export class FailurePackageBuilder {
  build(input: FailurePackageInput): FailurePackage {
    if (input.gate.decision !== "FAIL")
      throw new CapError(
        "Failure Package requires a FAIL gate decision",
        "FAILURE_PACKAGE_NOT_APPLICABLE",
      );
    const failureClass = input.failureClass ?? "IMPLEMENTATION_FAIL";
    const failures = input.matrix.requirements
      .filter((requirement) => requirement.result !== "PASS")
      .map((requirement) => this.toFailure(requirement, input, failureClass));
    const insufficient = input.matrix.requirements.filter(
      (requirement) =>
        requirement.result === "PASS" &&
        (!requirement.evidence_valid ||
          input.gate.reason_codes.includes("INSUFFICIENT_EVIDENCE")),
    );
    for (const requirement of insufficient)
      failures.push(this.toEvidenceFailure(requirement, input, failureClass));
    if (failures.length === 0) {
      failures.push({
        finding_id: `GATE-${input.run.id}`,
        requirement_id: "GATE",
        severity: "S1",
        expected: "All configured quality gates pass",
        observed: input.gate.reason_codes.join(", "),
        reproduction: ["Inspect acceptance/gate-decision.json"],
        evidence: ["acceptance/gate-decision.json"],
        suspected_areas: [],
        regression_risks: input.contract.requirements
          .filter((requirement) => requirement.criticality === "core")
          .map((requirement) => requirement.id),
        failure_class: failureClass,
      });
    }
    const requiredRetests = [
      ...new Set([
        ...failures.map((failure) => failure.requirement_id),
        ...input.contract.requirements
          .filter((requirement) => requirement.criticality === "core")
          .map((requirement) => requirement.id),
        "core-smoke",
      ]),
    ].sort();
    return validateDocument<FailurePackage>("failure-package", {
      version: 1,
      run_id: input.run.id,
      target_commit: input.run.targetCommit,
      task_id: input.task.id,
      decision: "FAIL",
      failures,
      required_retests: requiredRetests,
    });
  }

  private toFailure(
    requirement: MatrixRequirement,
    input: FailurePackageInput,
    failureClass: FailureClass,
  ): FailureItem {
    const finding = input.report.findings.find((candidate) =>
      requirement.finding_ids.includes(candidate.id),
    );
    return {
      finding_id:
        finding?.id ?? requirement.finding_ids[0] ?? `REQ-${requirement.id}`,
      requirement_id: requirement.id,
      severity: requirement.severity ?? finding?.severity ?? "S1",
      expected: finding?.expected ?? requirement.title,
      observed:
        finding?.observed ??
        `Requirement result was ${requirement.result}; gate reasons: ${input.gate.reason_codes.join(", ")}`,
      reproduction: finding?.reproduction ?? [
        `Run ${input.run.id}`,
        `Inspect requirement ${requirement.id} in acceptance/matrix.json`,
      ],
      evidence: [...requirement.artifacts].sort(),
      suspected_areas: [],
      regression_risks: input.contract.requirements
        .filter(
          (candidate) =>
            candidate.criticality === requirement.criticality ||
            candidate.id === requirement.id,
        )
        .map((candidate) => candidate.id),
      failure_class: failureClass,
    };
  }

  private toEvidenceFailure(
    requirement: MatrixRequirement,
    input: FailurePackageInput,
    failureClass: FailureClass,
  ): FailureItem {
    return {
      finding_id: `EVIDENCE-${requirement.id}`,
      requirement_id: requirement.id,
      severity: "S1",
      expected: `Evidence at least ${requirement.required_evidence}`,
      observed: `Evidence was ${requirement.actual_evidence} or referenced artifacts were missing`,
      reproduction: [
        `Inspect ${requirement.id} in acceptance/matrix.json`,
        "Verify every referenced artifact path exists in the finalized Run",
      ],
      evidence: requirement.artifacts,
      suspected_areas: ["reviewer evidence mapping"],
      regression_risks: [requirement.id],
      failure_class: failureClass,
    };
  }
}

export class FailurePackageService {
  constructor(
    private readonly artifacts: ArtifactStore,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  create(input: FailurePackageInput): {
    failurePackage: FailurePackage;
    fixRequest: FixRequest;
    failurePackagePath: string;
    fixRequestPath: string;
  } {
    const failurePackage = new FailurePackageBuilder().build(input);
    const failurePackagePath = this.artifacts.writeJson(
      input.run.projectId,
      input.run.taskId,
      input.run.id,
      "failure/failure-package.json",
      failurePackage,
    );
    const attempt = Math.max(1, input.task.failureCount);
    const fixRequest: FixRequest = {
      version: 1,
      request_id: `FIX-${randomUUID().slice(0, 8).toUpperCase()}`,
      task_id: input.task.id,
      source_run_id: input.run.id,
      source_commit: input.run.targetCommit,
      status: "OPEN",
      failure_package_path: "failure/failure-package.json",
      required_retests: failurePackage.required_retests,
      escalation_level: escalationForAttempt(attempt),
      attempt,
      created_at: this.now(),
      updated_at: this.now(),
    };
    validateDocument<FixRequest>("fix-request", fixRequest);
    const fixRequestPath = this.artifacts.writeJson(
      input.run.projectId,
      input.run.taskId,
      input.run.id,
      "failure/fix-request.json",
      fixRequest,
    );
    return { failurePackage, fixRequest, failurePackagePath, fixRequestPath };
  }
}

export function escalationForAttempt(attempt: number): EscalationLevel {
  if (attempt <= 1) return "AUTO_FIX";
  if (attempt === 2) return "ROOT_CAUSE_REVIEW";
  if (attempt === 3) return "ARCHITECTURE_REVIEW";
  return "HUMAN_REQUIRED";
}

export class ImpactAnalyzer {
  analyze(input: {
    runId: string;
    patch: string;
    contract: AcceptanceContract;
    failurePackage: FailurePackage;
  }): ImpactAnalysis {
    const changedFiles = [...input.patch.matchAll(/^\+\+\+ b\/(.+)$/gm)]
      .map((match) => match[1])
      .filter((value): value is string => value !== undefined)
      .sort();
    const impactedRequirementIds = input.failurePackage.failures
      .map((failure) => failure.requirement_id)
      .filter((id) =>
        input.contract.requirements.some(
          (requirement) => requirement.id === id,
        ),
      );
    const selectedRetests = [
      ...new Set([
        ...input.failurePackage.required_retests,
        ...input.contract.requirements
          .filter((requirement) => requirement.criticality === "core")
          .map((requirement) => requirement.id),
      ]),
    ].sort();
    return validateDocument<ImpactAnalysis>("impact-analysis", {
      version: 1,
      run_id: input.runId,
      changed_files: changedFiles,
      impacted_requirement_ids: [...new Set(impactedRequirementIds)].sort(),
      selected_retests: selectedRetests,
      reason:
        changedFiles.length > 0
          ? "Changed files were parsed from the target diff; MVP retests all core requirements."
          : "No changed-file patch was available; MVP retains all required retests.",
    });
  }
}
