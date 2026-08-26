import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { ArtifactStore } from "../../src/artifacts.js";
import { MultiReviewerEngine } from "../../src/multi-review.js";
import { decideGate } from "../../src/gate.js";
import { resolveAcceptanceHome } from "../../src/paths.js";
import {
  FakeReviewerProvider,
  ReviewerSessionManager,
  type ReviewerContext,
  type ReviewerReport,
} from "../../src/review.js";

const context: ReviewerContext = {
  runId: "RUN-MULTI",
  projectId: "project",
  taskId: "TASK-001",
  targetCommit: "0123456789abcdef0123456789abcdef01234567",
  worktreePath: ".",
  contract: {
    version: 1,
    contract_id: "contract-multi",
    task_id: "TASK-001",
    title: "Multi reviewer",
    requirements: [
      {
        id: "AC-CORE",
        title: "Core",
        criticality: "core",
        verification: { modes: ["unit"], required_evidence: "E1" },
      },
    ],
  },
  requirements: [
    {
      id: "AC-CORE",
      title: "Core",
      criticality: "core",
      verification: { modes: ["unit"], required_evidence: "E1" },
    },
  ],
  verifierResults: [],
  evidencePaths: [],
};

function report(result: "PASS" | "FAIL"): ReviewerReport {
  const failed = result === "FAIL";
  return {
    version: 1,
    run_id: context.runId,
    target_commit: context.targetCommit,
    reviewer_verdict: result,
    requirement_results: [
      {
        requirement_id: "AC-CORE",
        result,
        evidence_level: "E1",
        evidence_paths: [],
        ...(failed ? { severity: "S1" as const } : {}),
        finding_ids: failed ? ["FIND-FAIL"] : [],
      },
    ],
    findings: failed
      ? [
          {
            id: "FIND-FAIL",
            requirement_id: "AC-CORE",
            severity: "S1",
            title: "Failure",
            description: "Functional reviewer observed a failure",
            evidence_paths: [],
          },
        ]
      : [],
    requested_human_decisions: [],
    requested_probes: [],
    notes: [],
  };
}

test("conflicting reviewer roles produce HUMAN and retain their sessions", async () => {
  const root = await mkdtemp(join(process.cwd(), ".test-multi-review-"));
  const artifacts = new ArtifactStore(
    resolveAcceptanceHome(join(root, "home")),
  );
  const sessions = new ReviewerSessionManager(artifacts);
  const result = new MultiReviewerEngine(sessions, artifacts).run(context, [
    { role: "functional", provider: new FakeReviewerProvider(report("PASS")) },
    { role: "security", provider: new FakeReviewerProvider(report("FAIL")) },
  ]);
  assert.equal(result.report.reviewer_verdict, "HUMAN");
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0]?.requirement_id, "AC-CORE");
  assert.equal(
    result.sessions.every((session) => session.status === "RETAINED"),
    true,
  );
  assert.match(
    await readFile(
      join(
        artifacts.runRoot("project", "TASK-001", "RUN-MULTI"),
        "reviewer",
        "roles",
        "functional.json",
      ),
      "utf8",
    ),
    /AC-CORE/,
  );
  const gate = decideGate({
    matrix: {
      version: 1,
      run_id: context.runId,
      requirements: [
        {
          id: "AC-CORE",
          title: "Core",
          criticality: "core",
          result: "PASS",
          required_evidence: "E1",
          actual_evidence: "E1",
          artifacts: ["reviewer/roles/functional.json"],
          evidence_valid: true,
          finding_ids: ["CONFLICT-AC-CORE"],
          human_required: false,
        },
      ],
      coverage: {
        total: 1,
        pass: 1,
        fail: 0,
        not_tested: 0,
        blocked: 0,
        not_applicable: 0,
      },
    },
    report: result.report,
    verifierResults: [],
    humanTriggers: ["REVIEWER_CONFLICT"],
  });
  assert.equal(gate.decision, "HUMAN");
  assert.ok(gate.reason_codes.includes("REVIEWER_CONFLICT"));
  await rm(root, { recursive: true, force: true });
});
