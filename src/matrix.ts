import type {
  AcceptanceContract,
  ContractRequirement,
  EvidenceLevel,
} from "./domain.js";
import { evidenceForRequirement, type EvidenceIndex } from "./evidence.js";
import {
  evidenceRank,
  type RequirementResult,
  type ReviewerReport,
  type Severity,
} from "./review.js";

export interface MatrixRequirement {
  id: string;
  title: string;
  criticality: ContractRequirement["criticality"];
  result: RequirementResult;
  required_evidence: EvidenceLevel;
  actual_evidence: EvidenceLevel;
  artifacts: string[];
  evidence_valid: boolean;
  severity?: Severity;
  finding_ids: string[];
  human_required: boolean;
}

export interface MatrixCoverage {
  total: number;
  pass: number;
  fail: number;
  not_tested: number;
  blocked: number;
  not_applicable: number;
}

export interface AcceptanceMatrix {
  version: 1;
  run_id: string;
  requirements: MatrixRequirement[];
  coverage: MatrixCoverage;
}

export function buildAcceptanceMatrix(
  contract: AcceptanceContract,
  report: ReviewerReport,
  evidence: EvidenceIndex,
): AcceptanceMatrix {
  const requirements = contract.requirements.map((requirement) => {
    const result = report.requirement_results.find(
      (candidate) => candidate.requirement_id === requirement.id,
    );
    const linkedEvidence = evidenceForRequirement(evidence, requirement.id);
    const actualEvidence = linkedEvidence.reduce<EvidenceLevel>(
      (highest, candidate) =>
        evidenceRank(candidate.level) > evidenceRank(highest)
          ? candidate.level
          : highest,
      "E0",
    );
    const paths = linkedEvidence.map((candidate) => candidate.path);
    const declaredPaths = result?.evidence_paths ?? [];
    const evidenceValid =
      result?.result === "PASS" &&
      declaredPaths.length > 0 &&
      declaredPaths.every((path) =>
        linkedEvidence.some((candidate) => candidate.path === path),
      );
    const findingIds = [
      ...(result?.finding_ids ?? []),
      ...report.findings
        .filter((finding) => finding.requirement_id === requirement.id)
        .map((finding) => finding.id),
    ];
    return {
      id: requirement.id,
      title: requirement.title,
      criticality: requirement.criticality,
      result: result?.result ?? "NOT_TESTED",
      required_evidence: requirement.verification.required_evidence,
      actual_evidence: actualEvidence,
      artifacts: [...new Set(paths)].sort(),
      evidence_valid: evidenceValid,
      ...(result?.severity ? { severity: result.severity } : {}),
      finding_ids: [...new Set(findingIds)].sort(),
      human_required: requirement.human_required ?? false,
    } satisfies MatrixRequirement;
  });
  return {
    version: 1,
    run_id: report.run_id,
    requirements,
    coverage: {
      total: requirements.length,
      pass: requirements.filter((requirement) => requirement.result === "PASS")
        .length,
      fail: requirements.filter((requirement) => requirement.result === "FAIL")
        .length,
      not_tested: requirements.filter(
        (requirement) => requirement.result === "NOT_TESTED",
      ).length,
      blocked: requirements.filter(
        (requirement) => requirement.result === "BLOCKED",
      ).length,
      not_applicable: requirements.filter(
        (requirement) => requirement.result === "NOT_APPLICABLE",
      ).length,
    },
  };
}

export function writeAcceptanceMatrix(
  artifacts: {
    writeJson: (
      projectId: string,
      taskId: string,
      runId: string,
      relativePath: string,
      value: unknown,
    ) => string;
  },
  projectId: string,
  taskId: string,
  matrix: AcceptanceMatrix,
): string {
  return artifacts.writeJson(
    projectId,
    taskId,
    matrix.run_id,
    "acceptance/matrix.json",
    matrix,
  );
}
