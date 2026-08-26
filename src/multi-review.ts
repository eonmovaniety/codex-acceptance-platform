import type { AcceptanceContract, ContractRequirement } from "./domain.js";
import type { ArtifactStore } from "./artifacts.js";
import { CapError } from "./errors.js";
import {
  ReviewerSessionManager,
  type ReviewerContext,
  type ReviewerFinding,
  type ReviewerProvider,
  type ReviewerReport,
  type ReviewerRequirementResult,
  type ReviewerSession,
  type ReviewerVerdict,
} from "./review.js";
import { validateDocument } from "./validation.js";

export type ReviewerRole =
  "functional" | "visual" | "security" | "architecture" | "test-gap";

export interface RoleReviewer {
  role: ReviewerRole;
  provider: ReviewerProvider;
}

export interface ReviewerConflict {
  id: string;
  requirement_id: string;
  roles: ReviewerRole[];
  description: string;
}

export interface MultiReviewerResult {
  report: ReviewerReport;
  roleReports: Array<{ role: ReviewerRole; report: ReviewerReport }>;
  sessions: ReviewerSession[];
  conflicts: ReviewerConflict[];
}

export class MultiReviewerEngine {
  constructor(
    private readonly sessions: ReviewerSessionManager,
    private readonly artifacts: ArtifactStore,
  ) {}

  run(
    context: ReviewerContext,
    reviewers: RoleReviewer[],
  ): MultiReviewerResult {
    if (reviewers.length === 0)
      throw new CapError(
        "At least one reviewer role is required",
        "REVIEWERS_EMPTY",
      );
    const roleReports: Array<{ role: ReviewerRole; report: ReviewerReport }> =
      [];
    const activeSessions: Array<{
      role: ReviewerRole;
      session: ReviewerSession;
    }> = [];
    for (const reviewer of reviewers) {
      const session = this.sessions.start({
        projectId: context.projectId,
        taskId: context.taskId,
        runId: context.runId,
        provider: `${reviewer.role}:${reviewer.provider.name}`,
      });
      const result = reviewer.provider.review(context);
      const report = validateDocument<ReviewerReport>(
        "reviewer-report",
        result.report,
      );
      if (
        report.run_id !== context.runId ||
        report.target_commit !== context.targetCommit
      )
        throw new CapError(
          `Reviewer role ${reviewer.role} returned a different Run target`,
          "REVIEWER_REPORT_TARGET_MISMATCH",
        );
      const bound = result.providerSessionId
        ? this.sessions.bindProviderSession(
            session.id,
            result.providerSessionId,
          )
        : session;
      const persisted = this.sessions.persistReport(
        bound.id,
        report,
        `reviewer/roles/${reviewer.role}.json`,
      );
      activeSessions.push({ role: reviewer.role, session: persisted });
      roleReports.push({ role: reviewer.role, report });
    }
    const conflicts = findConflicts(context.requirements, roleReports);
    const report = mergeReports(context, roleReports, conflicts);
    validateDocument<ReviewerReport>("reviewer-report", report);
    this.artifacts.writeJson(
      context.projectId,
      context.taskId,
      context.runId,
      "reviewer/report.json",
      report,
    );
    const sessions = activeSessions.map(({ session }) =>
      this.sessions.cleanup(session.id, {
        retain: conflicts.length > 0 || hasCriticalFinding(roleReports),
        ...(conflicts.length > 0
          ? { reason: "reviewer-conflict" }
          : hasCriticalFinding(roleReports)
            ? { reason: "critical-finding" }
            : {}),
      }),
    );
    return { report, roleReports, sessions, conflicts };
  }
}

function mergeReports(
  context: ReviewerContext,
  roleReports: Array<{ role: ReviewerRole; report: ReviewerReport }>,
  conflicts: ReviewerConflict[],
): ReviewerReport {
  const requirementResults: ReviewerRequirementResult[] =
    context.requirements.map((requirement) => {
      const results = roleReports
        .map(({ report }) =>
          report.requirement_results.find(
            (candidate) => candidate.requirement_id === requirement.id,
          ),
        )
        .filter(
          (result): result is ReviewerRequirementResult => result !== undefined,
        );
      const result = mergeRequirementResult(results);
      const evidencePaths = [
        ...new Set(results.flatMap((candidate) => candidate.evidence_paths)),
      ].sort();
      const findingIds = [
        ...new Set(results.flatMap((candidate) => candidate.finding_ids)),
      ].sort();
      const highestSeverity = results
        .map((candidate) => candidate.severity)
        .filter(
          (
            severity,
          ): severity is NonNullable<ReviewerRequirementResult["severity"]> =>
            severity !== undefined,
        )
        .sort(severitySort)
        .at(-1);
      return {
        requirement_id: requirement.id,
        result,
        evidence_level: highestEvidence(results),
        evidence_paths: evidencePaths,
        ...(highestSeverity ? { severity: highestSeverity } : {}),
        finding_ids: findingIds,
      };
    });
  const findings = roleReports.flatMap(({ report }) => report.findings);
  for (const conflict of conflicts) {
    findings.push({
      id: conflict.id,
      requirement_id: conflict.requirement_id,
      severity: "S1",
      title: "Reviewer conflict",
      description: conflict.description,
      evidence_paths: [],
    });
  }
  const verdicts = roleReports.map(({ report }) => report.reviewer_verdict);
  const reviewerVerdict: ReviewerVerdict =
    conflicts.length > 0
      ? "HUMAN"
      : verdicts.some((verdict) => verdict === "FAIL")
        ? "FAIL"
        : verdicts.some((verdict) => verdict === "HUMAN")
          ? "HUMAN"
          : verdicts.every((verdict) => verdict === "PASS")
            ? "PASS"
            : "NOT_TESTED";
  return {
    version: 1,
    run_id: context.runId,
    target_commit: context.targetCommit,
    reviewer_verdict: reviewerVerdict,
    requirement_results: requirementResults,
    findings,
    requested_human_decisions: conflicts.map((conflict) => ({
      id: conflict.id,
      reason: "reviewer_conflict",
      question: `Resolve conflicting results for ${conflict.requirement_id}`,
      options: ["FUNCTIONAL_PASS", "FUNCTIONAL_FAIL", "DEFER"],
      risk: "Conflicting reviewers cannot be reconciled automatically",
    })),
    requested_probes: [],
    notes: [
      `Merged reviewer roles: ${roleReports.map(({ role }) => role).join(", ")}`,
      ...(conflicts.length > 0
        ? ["Reviewer conflict forces HUMAN; Gate remains authoritative."]
        : []),
    ],
  };
}

function mergeRequirementResult(
  results: ReviewerRequirementResult[],
): ReviewerRequirementResult["result"] {
  if (results.length === 0) return "NOT_TESTED";
  if (results.some((result) => result.result === "FAIL")) return "FAIL";
  if (results.some((result) => result.result === "BLOCKED")) return "BLOCKED";
  if (results.some((result) => result.result === "NOT_TESTED"))
    return "NOT_TESTED";
  if (results.every((result) => result.result === "NOT_APPLICABLE"))
    return "NOT_APPLICABLE";
  return "PASS";
}

function highestEvidence(
  results: ReviewerRequirementResult[],
): ReviewerRequirementResult["evidence_level"] {
  return (
    results
      .map((result) => result.evidence_level)
      .sort((left, right) => Number(left.slice(1)) - Number(right.slice(1)))
      .at(-1) ?? "E0"
  );
}

function findConflicts(
  requirements: ContractRequirement[],
  roleReports: Array<{ role: ReviewerRole; report: ReviewerReport }>,
): ReviewerConflict[] {
  const conflicts: ReviewerConflict[] = [];
  for (const requirement of requirements) {
    const observations = roleReports
      .map(({ role, report }) => ({
        role,
        result: report.requirement_results.find(
          (candidate) => candidate.requirement_id === requirement.id,
        )?.result,
      }))
      .filter((observation) => observation.result !== undefined);
    const results = new Set(
      observations.map((observation) => observation.result),
    );
    if (results.has("PASS") && results.has("FAIL")) {
      conflicts.push({
        id: `CONFLICT-${requirement.id}`,
        requirement_id: requirement.id,
        roles: observations
          .filter(
            (observation) =>
              observation.result === "PASS" || observation.result === "FAIL",
          )
          .map((observation) => observation.role),
        description: `Reviewer roles disagree on ${requirement.id}: ${observations
          .map((observation) => `${observation.role}=${observation.result}`)
          .join(", ")}`,
      });
    }
  }
  return conflicts;
}

function hasCriticalFinding(
  roleReports: Array<{ role: ReviewerRole; report: ReviewerReport }>,
): boolean {
  return roleReports.some(({ report }) =>
    report.findings.some(
      (finding) => finding.severity === "S0" || finding.severity === "S1",
    ),
  );
}

function severitySort(
  left: ReviewerFinding["severity"],
  right: ReviewerFinding["severity"],
): number {
  return (
    ["S0", "S1", "S2", "S3", "S4"].indexOf(left) -
    ["S0", "S1", "S2", "S3", "S4"].indexOf(right)
  );
}
