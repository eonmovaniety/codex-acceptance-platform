import assert from "node:assert/strict";
import test from "node:test";
import {
  CodexCliReviewerProvider,
  FakeReviewerProvider,
  type CodexProcessRunner,
  type ReviewerContext,
  type ReviewerReport,
} from "../../src/review.js";

const context: ReviewerContext = {
  runId: "RUN-001",
  projectId: "project",
  taskId: "TASK-001",
  targetCommit: "0123456789abcdef0123456789abcdef01234567",
  worktreePath: "C:\\cap-worktree",
  contract: {
    version: 1,
    contract_id: "contract-1",
    task_id: "TASK-001",
    title: "Review contract",
    requirements: [
      {
        id: "AC-CORE",
        title: "Core behavior",
        criticality: "core",
        verification: { modes: ["unit"], required_evidence: "E2" },
      },
    ],
  },
  requirements: [
    {
      id: "AC-CORE",
      title: "Core behavior",
      criticality: "core",
      verification: { modes: ["unit"], required_evidence: "E2" },
    },
  ],
  verifierResults: [
    {
      version: 1,
      run_id: "RUN-001",
      verifier: "unit",
      stage: "unit",
      result: "PASS",
      started_at: "2026-08-27T00:00:00.000Z",
      completed_at: "2026-08-27T00:00:01.000Z",
      exit_code: 0,
      evidence: [],
      warnings: [],
    },
  ],
  evidencePaths: ["verifier/summary.json"],
};

function validReport(): ReviewerReport {
  return {
    version: 1,
    run_id: context.runId,
    target_commit: context.targetCommit,
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
  };
}

test("fake reviewer is deterministic and carries verifier evidence", () => {
  const result = new FakeReviewerProvider().review(context);
  assert.equal(result.report.reviewer_verdict, "PASS");
  assert.equal(result.report.requirement_results[0]?.result, "PASS");
  assert.deepEqual(result.report.requirement_results[0]?.evidence_paths, [
    "verifier/summary.json",
  ]);
});

test("Codex CLI provider uses read-only ephemeral structured execution", () => {
  let executable = "";
  let args: string[] = [];
  const runner: CodexProcessRunner = {
    run(currentExecutable, currentArgs) {
      executable = currentExecutable;
      args = currentArgs;
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          type: "item.completed",
          thread_id: "codex-thread-1",
          item: { type: "agent_message", text: JSON.stringify(validReport()) },
        }),
        stderr: "",
      };
    },
  };
  const result = new CodexCliReviewerProvider({
    schemaPath: "schemas/reviewer-report.schema.json",
    processRunner: runner,
  }).review(context);
  assert.equal(executable, "codex");
  assert.ok(args.includes("exec"));
  assert.ok(args.includes("--sandbox"));
  assert.ok(args.includes("read-only"));
  assert.ok(args.includes("--json"));
  assert.ok(args.includes("--ephemeral"));
  assert.ok(args.includes("--output-schema"));
  assert.equal(result.providerSessionId, "codex-thread-1");
  assert.equal(result.report.run_id, "RUN-001");
});

test("Codex CLI provider rejects a missing structured report", () => {
  const runner: CodexProcessRunner = {
    run() {
      return { exitCode: 0, stdout: "not a report", stderr: "" };
    },
  };
  assert.throws(
    () =>
      new CodexCliReviewerProvider({
        schemaPath: "schemas/reviewer-report.schema.json",
        processRunner: runner,
      }).review(context),
    /did not emit a reviewer report/,
  );
});
