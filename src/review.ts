import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type {
  AcceptanceContract,
  ContractRequirement,
  Criticality,
  EvidenceLevel,
} from "./domain.js";
import { CapError } from "./errors.js";
import type { ArtifactStore } from "./artifacts.js";
import type { VerifierResult } from "./verifier.js";
import { aggregateVerifierResults } from "./verifier.js";
import { sanitizedEnvironment } from "./runner.js";
import { validateDocument } from "./validation.js";

export type RequirementResult =
  "PASS" | "FAIL" | "NOT_TESTED" | "BLOCKED" | "NOT_APPLICABLE";
export type ReviewerVerdict = "PASS" | "FAIL" | "HUMAN" | "NOT_TESTED";
export type Severity = "S0" | "S1" | "S2" | "S3" | "S4";

export interface ReviewerFinding {
  id: string;
  requirement_id: string;
  severity: Severity;
  title: string;
  description: string;
  expected?: string;
  observed?: string;
  reproduction?: string[];
  evidence_paths: string[];
}

export interface ReviewerRequirementResult {
  requirement_id: string;
  result: RequirementResult;
  evidence_level: EvidenceLevel;
  evidence_paths: string[];
  severity?: Severity;
  finding_ids: string[];
  expected?: string;
  observed?: string;
  reproduction?: string[];
  notes?: string[];
}

export interface ReviewerHumanRequest {
  id: string;
  reason: string;
  question: string;
  options: string[];
  risk: string;
}

export interface ReviewerReport {
  version: 1;
  run_id: string;
  target_commit: string;
  reviewer_verdict: ReviewerVerdict;
  requirement_results: ReviewerRequirementResult[];
  findings: ReviewerFinding[];
  requested_human_decisions: ReviewerHumanRequest[];
  requested_probes: string[];
  notes: string[];
}

export interface ReviewerContext {
  runId: string;
  projectId: string;
  taskId: string;
  targetCommit: string;
  worktreePath: string;
  contract: AcceptanceContract;
  requirements: ContractRequirement[];
  verifierResults: VerifierResult[];
  evidencePaths: string[];
  priorFailurePaths?: string[];
  now?: () => string;
}

export interface ReviewerProviderResult {
  report: ReviewerReport;
  providerSessionId?: string;
  rawOutput?: string;
}

export interface ReviewerProvider {
  readonly name: string;
  review(context: ReviewerContext): ReviewerProviderResult;
}

export class ReviewerProviderError extends CapError {
  constructor(message: string, code = "REVIEWER_PROVIDER_FAILED") {
    super(message, code);
    this.name = "ReviewerProviderError";
  }
}

export class FakeReviewerProvider implements ReviewerProvider {
  readonly name = "fake";

  constructor(
    private readonly fixedReport?: ReviewerReport,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  review(context: ReviewerContext): ReviewerProviderResult {
    if (this.fixedReport) {
      return { report: structuredClone(this.fixedReport) };
    }

    const aggregate = aggregateVerifierResults(context.verifierResults);
    const evidencePaths = context.evidencePaths.slice().sort();
    const result: RequirementResult =
      aggregate === "PASS"
        ? "PASS"
        : aggregate === "BLOCKED"
          ? "BLOCKED"
          : aggregate === "FAIL"
            ? "FAIL"
            : "NOT_TESTED";
    const firstCore = context.requirements.find(
      (requirement) => requirement.criticality === "core",
    );
    const requirementResults: ReviewerRequirementResult[] =
      context.requirements.map((requirement): ReviewerRequirementResult => {
        const isPrimaryFailure =
          result === "FAIL" &&
          (requirement.id === firstCore?.id || firstCore === undefined);
        const requirementEvidence = result === "PASS" ? evidencePaths : [];
        return {
          requirement_id: requirement.id,
          result: isPrimaryFailure ? "FAIL" : result,
          evidence_level:
            result === "PASS"
              ? requirement.verification.required_evidence
              : "E0",
          evidence_paths: requirementEvidence,
          ...(isPrimaryFailure
            ? {
                severity: "S1" as const,
                finding_ids: [`FAKE-${requirement.id}`],
                expected: requirement.expected?.join("; ") ?? requirement.title,
                observed:
                  "A deterministic verifier did not complete successfully",
                reproduction: [
                  "Inspect verifier/summary.json and stage artifacts",
                ],
              }
            : { finding_ids: [] }),
        } satisfies ReviewerRequirementResult;
      });
    const findings = requirementResults
      .filter((requirement) => requirement.result === "FAIL")
      .map(
        (requirement) =>
          ({
            id:
              requirement.finding_ids[0] ??
              `FAKE-${requirement.requirement_id}`,
            requirement_id: requirement.requirement_id,
            severity: requirement.severity ?? "S1",
            title: "Deterministic verifier failure",
            description: requirement.observed ?? "Verifier failure",
            ...(requirement.expected ? { expected: requirement.expected } : {}),
            ...(requirement.observed ? { observed: requirement.observed } : {}),
            ...(requirement.reproduction
              ? { reproduction: requirement.reproduction }
              : {}),
            evidence_paths: [],
          }) satisfies ReviewerFinding,
      );

    return {
      report: {
        version: 1,
        run_id: context.runId,
        target_commit: context.targetCommit,
        reviewer_verdict:
          result === "PASS"
            ? "PASS"
            : result === "BLOCKED"
              ? "HUMAN"
              : result === "NOT_TESTED"
                ? "NOT_TESTED"
                : "FAIL",
        requirement_results: requirementResults,
        findings,
        requested_human_decisions: [],
        requested_probes: [],
        notes: [
          `Fake reviewer generated at ${this.clock()}`,
          `Contract ${context.contract.contract_id} was evaluated without external model access`,
        ],
      },
    };
  }
}

export interface CodexProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface CodexProcessRunner {
  run(
    executable: string,
    args: string[],
    options: { cwd: string },
  ): CodexProcessResult;
}

export class LocalCodexProcessRunner implements CodexProcessRunner {
  run(
    executable: string,
    args: string[],
    options: { cwd: string },
  ): CodexProcessResult {
    const result = spawnSync(executable, args, {
      cwd: options.cwd,
      env: sanitizedEnvironment(),
      encoding: "utf8",
      windowsHide: true,
      shell: false,
    });
    const processError = result.error as NodeJS.ErrnoException | undefined;
    return {
      exitCode: processError ? null : result.status,
      stdout: typeof result.stdout === "string" ? result.stdout : "",
      stderr:
        typeof result.stderr === "string"
          ? result.stderr
          : (processError?.message ?? ""),
    };
  }
}

export interface CodexCliReviewerOptions {
  schemaPath: string;
  executable?: string;
  outputLastMessagePath?: string;
  processRunner?: CodexProcessRunner;
}

export class CodexCliReviewerProvider implements ReviewerProvider {
  readonly name = "codex";

  private readonly executable: string;
  private readonly processRunner: CodexProcessRunner;

  constructor(private readonly options: CodexCliReviewerOptions) {
    this.executable = options.executable ?? "codex";
    this.processRunner = options.processRunner ?? new LocalCodexProcessRunner();
  }

  review(context: ReviewerContext): ReviewerProviderResult {
    const prompt = buildReviewerPrompt(context);
    const args = [
      "exec",
      "--sandbox",
      "read-only",
      "--json",
      "--output-schema",
      this.options.schemaPath,
      ...(this.options.outputLastMessagePath
        ? ["--output-last-message", this.options.outputLastMessagePath]
        : []),
      "--ephemeral",
      "--cd",
      context.worktreePath,
      prompt,
    ];
    const result = this.processRunner.run(this.executable, args, {
      cwd: context.worktreePath,
    });
    if (result.exitCode !== 0) {
      throw new ReviewerProviderError(
        `Codex CLI exited with ${String(result.exitCode)}: ${truncate(result.stderr)}`,
        "REVIEWER_INFRA_FAILED",
      );
    }
    const parsed = parseCodexOutput(
      result.stdout,
      this.options.outputLastMessagePath,
    );
    if (!parsed) {
      throw new ReviewerProviderError(
        "Codex CLI did not emit a reviewer report",
        "REVIEWER_REPORT_MISSING",
      );
    }
    const report = validateDocument<ReviewerReport>(
      "reviewer-report",
      parsed.report,
    );
    return {
      report,
      ...(parsed.sessionId ? { providerSessionId: parsed.sessionId } : {}),
      rawOutput: result.stdout,
    };
  }
}

interface ParsedCodexOutput {
  report: unknown;
  sessionId?: string;
}

function parseCodexOutput(
  stdout: string,
  outputLastMessagePath?: string,
): ParsedCodexOutput | undefined {
  const values: unknown[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      values.push(JSON.parse(line) as unknown);
    } catch {
      // JSONL can contain non-JSON diagnostic lines; stderr remains the raw log.
    }
  }
  if (values.length === 0) {
    try {
      values.push(JSON.parse(stdout) as unknown);
    } catch {
      // Fall through to the optional output-last-message file.
    }
  }
  let sessionId: string | undefined;
  for (const value of values) {
    if (isRecord(value)) {
      const candidate = value.thread_id ?? value.session_id;
      if (typeof candidate === "string") sessionId = candidate;
    }
  }
  for (const value of values.toReversed()) {
    const report = findReport(value);
    if (report) return { report, ...(sessionId ? { sessionId } : {}) };
  }
  if (outputLastMessagePath && existsSync(outputLastMessagePath)) {
    const text = readFileSync(outputLastMessagePath, "utf8");
    try {
      return {
        report: JSON.parse(text) as unknown,
        ...(sessionId ? { sessionId } : {}),
      };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function findReport(value: unknown): unknown | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.run_id === "string" &&
    typeof value.target_commit === "string" &&
    Array.isArray(value.requirement_results)
  )
    return value;
  for (const key of [
    "item",
    "result",
    "output",
    "output_text",
    "message",
    "text",
    "data",
  ]) {
    const nested = value[key];
    if (typeof nested === "string") {
      try {
        const parsed = JSON.parse(nested) as unknown;
        const report = findReport(parsed);
        if (report) return report;
      } catch {
        // Text may be a normal model message rather than JSON.
      }
    } else {
      const report = findReport(nested);
      if (report) return report;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function buildReviewerPrompt(context: ReviewerContext): string {
  const payload = {
    run_id: context.runId,
    project_id: context.projectId,
    task_id: context.taskId,
    target_commit: context.targetCommit,
    contract: context.contract,
    requirements: context.requirements,
    verifier_results: context.verifierResults,
    evidence_paths: context.evidencePaths,
    prior_failure_paths: context.priorFailurePaths ?? [],
  };
  return [
    "Act as the CAP Acceptance Reviewer.",
    "Evaluate only the fixed target commit and the supplied contract and evidence.",
    "Do not modify files, do not approve based on prose alone, and do not treat builder self-checks as independent acceptance.",
    "Return exactly one JSON object matching the reviewer-report schema.",
    "Every PASS requirement must name existing evidence paths and an evidence_level at least the contract minimum.",
    JSON.stringify(payload),
  ].join("\n");
}

function truncate(value: string, max = 400): string {
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}

export interface ReviewerSession {
  id: string;
  runId: string;
  projectId: string;
  taskId: string;
  provider: string;
  status: "ACTIVE" | "REPORT_PERSISTED" | "ARCHIVED" | "RETAINED";
  createdAt: string;
  providerSessionId?: string;
  reportPath?: string;
  retainedReason?: string;
}

export class ReviewerSessionManager {
  private readonly sessions = new Map<string, ReviewerSession>();

  constructor(
    private readonly artifacts: ArtifactStore,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  start(input: {
    projectId: string;
    taskId: string;
    runId: string;
    provider: string;
  }): ReviewerSession {
    const session: ReviewerSession = {
      id: randomUUID(),
      runId: input.runId,
      projectId: input.projectId,
      taskId: input.taskId,
      provider: input.provider,
      status: "ACTIVE",
      createdAt: this.now(),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  bindProviderSession(
    sessionId: string,
    providerSessionId: string,
  ): ReviewerSession {
    const session = this.get(sessionId);
    const updated = { ...session, providerSessionId };
    this.sessions.set(sessionId, updated);
    return updated;
  }

  persistReport(sessionId: string, report: ReviewerReport): ReviewerSession {
    const session = this.get(sessionId);
    if (session.status !== "ACTIVE")
      throw new CapError(
        `Reviewer session is not active: ${sessionId}`,
        "SESSION_NOT_ACTIVE",
      );
    validateDocument<ReviewerReport>("reviewer-report", report);
    const reportPath = this.artifacts.writeJson(
      session.projectId,
      session.taskId,
      session.runId,
      "reviewer/report.json",
      report,
    );
    const updated: ReviewerSession = {
      ...session,
      status: "REPORT_PERSISTED",
      reportPath,
    };
    this.sessions.set(sessionId, updated);
    return updated;
  }

  cleanup(
    sessionId: string,
    options: { retain?: boolean; reason?: string } = {},
  ): ReviewerSession {
    const session = this.get(sessionId);
    if (session.status !== "REPORT_PERSISTED")
      throw new CapError(
        `Reviewer session cannot be cleaned before report persistence: ${sessionId}`,
        "SESSION_CLEANUP_BLOCKED",
      );
    const retained = options.retain ?? false;
    const updated: ReviewerSession = {
      ...session,
      status: retained ? "RETAINED" : "ARCHIVED",
      ...(retained && options.reason ? { retainedReason: options.reason } : {}),
    };
    this.sessions.set(sessionId, updated);
    return updated;
  }

  get(sessionId: string): ReviewerSession {
    const session = this.sessions.get(sessionId);
    if (!session)
      throw new CapError(
        `Reviewer session not found: ${sessionId}`,
        "SESSION_NOT_FOUND",
      );
    return session;
  }
}

export interface ReviewExecutionResult {
  report: ReviewerReport;
  session: ReviewerSession;
}

export class ReviewerService {
  constructor(
    private readonly sessions: ReviewerSessionManager,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  review(
    context: ReviewerContext,
    provider: ReviewerProvider,
  ): ReviewExecutionResult {
    const session = this.sessions.start({
      projectId: context.projectId,
      taskId: context.taskId,
      runId: context.runId,
      provider: provider.name,
    });
    const result = provider.review(context);
    const report = validateDocument<ReviewerReport>(
      "reviewer-report",
      result.report,
    );
    if (
      report.run_id !== context.runId ||
      report.target_commit !== context.targetCommit
    ) {
      throw new ReviewerProviderError(
        "Reviewer report does not identify the current Run target",
        "REVIEWER_REPORT_TARGET_MISMATCH",
      );
    }
    const bound = result.providerSessionId
      ? this.sessions.bindProviderSession(session.id, result.providerSessionId)
      : session;
    const persisted = this.sessions.persistReport(bound.id, report);
    const retain =
      report.reviewer_verdict === "HUMAN" ||
      report.findings.some(
        (finding) => finding.severity === "S0" || finding.severity === "S1",
      );
    const cleaned = this.sessions.cleanup(persisted.id, {
      retain,
      ...(retain ? { reason: "critical-finding-or-human-review" } : {}),
    });
    return { report, session: cleaned };
  }
}

export function criticalityOf(
  requirementId: string,
  requirements: ContractRequirement[],
): Criticality {
  return (
    requirements.find((requirement) => requirement.id === requirementId)
      ?.criticality ?? "minor"
  );
}

export function evidenceRank(level: EvidenceLevel): number {
  return Number(level.slice(1));
}
