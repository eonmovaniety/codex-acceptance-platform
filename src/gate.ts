import type { RunDecision, EvidenceLevel } from "./domain.js";
import { aggregateVerifierResults, type VerifierResult } from "./verifier.js";
import {
  evidenceRank,
  type ReviewerFinding,
  type ReviewerReport,
} from "./review.js";
import type { AcceptanceMatrix } from "./matrix.js";
import { validateDocument } from "./validation.js";

export interface GatePolicy {
  version: 1;
  mandatory_verifiers: string[];
  severity: {
    S0_max: number;
    S1_max: number;
    S2_max_core: number;
    S2_max_total: number;
  };
  requirements: {
    core_must_pass: boolean;
    not_tested_core_allowed: boolean;
    blocked_core_allowed: boolean;
  };
  evidence: {
    enforce_contract_minimum: boolean;
  };
  visual: {
    baseline_change_requires_human: boolean;
  };
  release: {
    requires_human: boolean;
  };
}

export const defaultGatePolicy: GatePolicy = {
  version: 1,
  mandatory_verifiers: ["build", "unit"],
  severity: {
    S0_max: 0,
    S1_max: 0,
    S2_max_core: 0,
    S2_max_total: 2,
  },
  requirements: {
    core_must_pass: true,
    not_tested_core_allowed: false,
    blocked_core_allowed: false,
  },
  evidence: {
    enforce_contract_minimum: true,
  },
  visual: {
    baseline_change_requires_human: true,
  },
  release: {
    requires_human: true,
  },
};

export interface GateDecision {
  version: 1;
  run_id: string;
  decision: RunDecision;
  reason_codes: string[];
  policy_version: string;
  created_at: string;
  details: {
    verifier_result: string;
    severity_counts: Record<string, number>;
    human_triggers: string[];
  };
}

export interface GateInput {
  matrix: AcceptanceMatrix;
  report: ReviewerReport;
  verifierResults: VerifierResult[];
  policy?: GatePolicy;
  hasInfraFailure?: boolean;
  additionalFindings?: ReviewerFinding[];
  humanTriggers?: string[];
  now?: () => string;
}

export function decideGate(input: GateInput): GateDecision {
  const policy = input.policy ?? defaultGatePolicy;
  const humanTriggers = [...new Set(input.humanTriggers ?? [])].sort();
  const severityCounts = countSeverities(input);
  const verifierResult = aggregateVerifierResults(input.verifierResults);
  const reasons: string[] = [];

  if (input.hasInfraFailure || verifierResult === "BLOCKED") {
    reasons.push("INFRA_FAILURE");
    return decision(
      "HUMAN",
      reasons,
      input,
      verifierResult,
      severityCounts,
      humanTriggers,
    );
  }

  if (
    humanTriggers.includes("REVIEWER_CONFLICT") ||
    input.report.requested_human_decisions.some(
      (request) => request.reason === "reviewer_conflict",
    )
  ) {
    reasons.push("REVIEWER_CONFLICT");
    return decision(
      "HUMAN",
      reasons,
      input,
      verifierResult,
      severityCounts,
      humanTriggers,
    );
  }

  const mandatoryFailure = policy.mandatory_verifiers.some((name) => {
    const matching = input.verifierResults.filter(
      (result) => result.verifier === name || result.stage === name,
    );
    return (
      matching.length === 0 ||
      matching.some(
        (result) =>
          result.result === "FAIL" ||
          result.result === "BLOCKED" ||
          result.result === "NOT_TESTED",
      )
    );
  });
  if (mandatoryFailure) reasons.push("MANDATORY_VERIFIER_FAILED");

  if (severityCounts.S0 > policy.severity.S0_max) reasons.push("S0_FINDING");
  if (severityCounts.S1 > policy.severity.S1_max) reasons.push("S1_FINDING");
  if (
    severityCounts.S2_CORE > policy.severity.S2_max_core ||
    severityCounts.S2 > policy.severity.S2_max_total
  )
    reasons.push("MAJOR_FINDING_LIMIT");

  const core = input.matrix.requirements.filter(
    (requirement) => requirement.criticality === "core",
  );
  const coreNotPass = core.filter((requirement) => {
    if (requirement.result === "PASS") return false;
    if (requirement.result === "NOT_TESTED")
      return !policy.requirements.not_tested_core_allowed;
    if (requirement.result === "BLOCKED")
      return !policy.requirements.blocked_core_allowed;
    return true;
  });
  if (policy.requirements.core_must_pass && coreNotPass.length > 0)
    reasons.push("CORE_REQUIREMENT_NOT_PASS");

  const insufficientEvidence = input.matrix.requirements.some(
    (requirement) =>
      requirement.result === "PASS" &&
      (!requirement.evidence_valid ||
        (policy.evidence.enforce_contract_minimum &&
          evidenceRank(requirement.actual_evidence) <
            evidenceRank(requirement.required_evidence))),
  );
  if (insufficientEvidence) reasons.push("INSUFFICIENT_EVIDENCE");

  if (input.report.reviewer_verdict === "NOT_TESTED")
    reasons.push("REVIEWER_NOT_TESTED");
  if (
    input.report.reviewer_verdict === "FAIL" &&
    input.matrix.coverage.fail === 0
  )
    reasons.push("REVIEWER_VERDICT_FAIL");

  const humanResult = input.matrix.requirements.some(
    (requirement) => requirement.human_required,
  );
  if (humanResult) humanTriggers.push("REQUIREMENT_REQUIRES_HUMAN");
  if (input.report.reviewer_verdict === "HUMAN")
    humanTriggers.push("REVIEWER_REQUESTED_HUMAN");

  let decisionValue: RunDecision;
  if (reasons.length > 0) decisionValue = "FAIL";
  else if (humanTriggers.length > 0) decisionValue = "HUMAN";
  else if (input.matrix.requirements.length === 0) {
    reasons.push("NO_REQUIREMENTS");
    decisionValue = "FAIL";
  } else decisionValue = "PASS";
  return decision(
    decisionValue,
    reasons.length > 0 ? reasons : ["ALL_GATES_SATISFIED"],
    input,
    verifierResult,
    severityCounts,
    [...new Set(humanTriggers)].sort(),
  );
}

export function writeGateDecision(
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
  gate: GateDecision,
): string {
  validateDocument<GateDecision>("gate-decision", gate);
  return artifacts.writeJson(
    projectId,
    taskId,
    gate.run_id,
    "acceptance/gate-decision.json",
    gate,
  );
}

function decision(
  value: RunDecision,
  reasons: string[],
  input: GateInput,
  verifierResult: string,
  severityCounts: Record<string, number>,
  humanTriggers: string[],
): GateDecision {
  return {
    version: 1,
    run_id: input.matrix.run_id,
    decision: value,
    reason_codes: [...new Set(reasons)],
    policy_version: `gate-v${String((input.policy ?? defaultGatePolicy).version)}`,
    created_at: input.now?.() ?? new Date().toISOString(),
    details: {
      verifier_result: verifierResult,
      severity_counts: severityCounts,
      human_triggers: humanTriggers,
    },
  };
}

function countSeverities(input: GateInput): Record<string, number> & {
  S0: number;
  S1: number;
  S2: number;
  S2_CORE: number;
} {
  const counts = { S0: 0, S1: 0, S2: 0, S3: 0, S4: 0, S2_CORE: 0 };
  const findings = [
    ...input.report.findings,
    ...(input.additionalFindings ?? []),
  ];
  for (const finding of findings) {
    counts[finding.severity] += 1;
    if (finding.severity === "S2") {
      const requirement = input.matrix.requirements.find(
        (candidate) => candidate.id === finding.requirement_id,
      );
      if (requirement?.criticality === "core") counts.S2_CORE += 1;
    }
  }
  for (const requirement of input.matrix.requirements) {
    if (!requirement.severity) continue;
    const alreadyCounted = findings.some(
      (finding) =>
        finding.requirement_id === requirement.id &&
        finding.severity === requirement.severity,
    );
    if (alreadyCounted) continue;
    counts[requirement.severity] += 1;
    if (requirement.severity === "S2" && requirement.criticality === "core")
      counts.S2_CORE += 1;
  }
  return counts;
}

export function minimumEvidenceSatisfied(
  actual: EvidenceLevel,
  required: EvidenceLevel,
): boolean {
  return evidenceRank(actual) >= evidenceRank(required);
}
