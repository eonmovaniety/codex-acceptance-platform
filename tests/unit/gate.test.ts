import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { ArtifactStore } from "../../src/artifacts.js";
import type { AcceptanceContract } from "../../src/domain.js";
import {
  EvidenceIndexBuilder,
  type EvidenceIndex,
} from "../../src/evidence.js";
import { decideGate } from "../../src/gate.js";
import { buildAcceptanceMatrix } from "../../src/matrix.js";
import type { ReviewerReport } from "../../src/review.js";
import { resolveAcceptanceHome } from "../../src/paths.js";
import type { VerifierResult } from "../../src/verifier.js";

const contract: AcceptanceContract = {
  version: 1,
  contract_id: "contract-1",
  task_id: "TASK-001",
  title: "Gate contract",
  requirements: [
    {
      id: "AC-CORE",
      title: "Core behavior",
      criticality: "core",
      verification: { modes: ["unit"], required_evidence: "E2" },
    },
  ],
};

const verifierResults: VerifierResult[] = [
  verifier("build", "build"),
  verifier("unit", "unit"),
];

function verifier(
  verifierName: string,
  stage: "build" | "unit",
): VerifierResult {
  return {
    version: 1,
    run_id: "RUN-001",
    verifier: verifierName,
    stage,
    result: "PASS",
    started_at: "2026-08-27T00:00:00.000Z",
    completed_at: "2026-08-27T00:00:01.000Z",
    exit_code: 0,
    evidence: [],
    warnings: [],
  };
}

function report(overrides: Partial<ReviewerReport> = {}): ReviewerReport {
  return {
    version: 1,
    run_id: "RUN-001",
    target_commit: "0123456789abcdef0123456789abcdef01234567",
    reviewer_verdict: "PASS",
    requirement_results: [
      {
        requirement_id: "AC-CORE",
        result: "PASS",
        evidence_level: "E2",
        evidence_paths: ["verifier/summary.json"],
        finding_ids: [],
      },
    ],
    findings: [],
    requested_human_decisions: [],
    requested_probes: [],
    notes: [],
    ...overrides,
  };
}

function evidence(exists: boolean): EvidenceIndex {
  return {
    version: 1,
    run_id: "RUN-001",
    records: [
      {
        id: "EVID-1",
        run_id: "RUN-001",
        requirement_id: "AC-CORE",
        source: "reviewer",
        kind: "test-report",
        path: "verifier/summary.json",
        level: "E2",
        exists,
      },
    ],
  };
}

test("gate passes only when mandatory verifier and contract evidence pass", () => {
  const currentReport = report();
  const matrix = buildAcceptanceMatrix(contract, currentReport, evidence(true));
  const decision = decideGate({
    matrix,
    report: currentReport,
    verifierResults,
    now: () => "2026-08-27T00:00:02.000Z",
  });
  assert.equal(decision.decision, "PASS");
  assert.deepEqual(decision.reason_codes, ["ALL_GATES_SATISFIED"]);
});

test("missing or non-existent evidence prevents PASS", () => {
  const currentReport = report({
    requirement_results: [
      {
        requirement_id: "AC-CORE",
        result: "PASS",
        evidence_level: "E2",
        evidence_paths: ["verifier/missing.json"],
        finding_ids: [],
      },
    ],
  });
  const matrix = buildAcceptanceMatrix(
    contract,
    currentReport,
    evidence(false),
  );
  const decision = decideGate({
    matrix,
    report: currentReport,
    verifierResults,
  });
  assert.equal(decision.decision, "FAIL");
  assert.ok(decision.reason_codes.includes("INSUFFICIENT_EVIDENCE"));
});

test("core NOT_TESTED is a deterministic failure", () => {
  const currentReport = report({
    reviewer_verdict: "NOT_TESTED",
    requirement_results: [
      {
        requirement_id: "AC-CORE",
        result: "NOT_TESTED",
        evidence_level: "E0",
        evidence_paths: [],
        finding_ids: [],
      },
    ],
  });
  const matrix = buildAcceptanceMatrix(
    contract,
    currentReport,
    evidence(false),
  );
  const decision = decideGate({
    matrix,
    report: currentReport,
    verifierResults,
  });
  assert.equal(decision.decision, "FAIL");
  assert.ok(decision.reason_codes.includes("CORE_REQUIREMENT_NOT_PASS"));
  assert.ok(decision.reason_codes.includes("REVIEWER_NOT_TESTED"));
});

test("infrastructure failure and human trigger never become PASS", () => {
  const currentReport = report();
  const matrix = buildAcceptanceMatrix(contract, currentReport, evidence(true));
  const infra = decideGate({
    matrix,
    report: currentReport,
    verifierResults,
    hasInfraFailure: true,
  });
  assert.equal(infra.decision, "HUMAN");
  assert.deepEqual(infra.reason_codes, ["INFRA_FAILURE"]);

  const human = decideGate({
    matrix,
    report: currentReport,
    verifierResults,
    humanTriggers: ["BASELINE_CHANGE"],
  });
  assert.equal(human.decision, "HUMAN");
  assert.deepEqual(human.details.human_triggers, ["BASELINE_CHANGE"]);
});

test("visual audit findings are evaluated by the deterministic Gate", () => {
  const currentReport = report();
  const matrix = buildAcceptanceMatrix(contract, currentReport, evidence(true));
  const decision = decideGate({
    matrix,
    report: currentReport,
    verifierResults,
    additionalFindings: [
      {
        id: "VISUAL-geometry-card",
        requirement_id: "AC-CORE",
        severity: "S2",
        title: "Geometry mismatch",
        description: "The card is wider than the contract allows",
        evidence_paths: [],
      },
    ],
  });
  assert.equal(decision.decision, "FAIL");
  assert.ok(decision.reason_codes.includes("MAJOR_FINDING_LIMIT"));
});

test("evidence index records actual artifact existence", async () => {
  const root = await mkdtemp(join(process.cwd(), ".test-gate-"));
  const artifacts = new ArtifactStore(
    resolveAcceptanceHome(join(root, "home")),
  );
  artifacts.writeText(
    "project",
    "TASK-001",
    "RUN-001",
    "verifier/summary.json",
    "{}\n",
  );
  const index = new EvidenceIndexBuilder().build({
    projectId: "project",
    taskId: "TASK-001",
    runId: "RUN-001",
    artifacts,
    verifierResults: [
      {
        ...verifierResults[0]!,
        evidence: [
          { kind: "test-report", path: "verifier/summary.json", level: "E2" },
        ],
      },
    ],
    reviewerReport: report(),
  });
  assert.ok(
    index.records.some(
      (record) => record.path === "verifier/summary.json" && record.exists,
    ),
  );
  await rm(root, { recursive: true, force: true });
});
