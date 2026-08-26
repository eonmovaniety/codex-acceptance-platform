import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { ArtifactStore } from "../../src/artifacts.js";
import { resolveAcceptanceHome } from "../../src/paths.js";
import {
  FakeReviewerProvider,
  ReviewerSessionManager,
  ReviewerService,
  type ReviewerContext,
  type ReviewerReport,
} from "../../src/review.js";

function context(runId: string): ReviewerContext {
  return {
    runId,
    projectId: "project",
    taskId: "TASK-001",
    targetCommit: "0123456789abcdef0123456789abcdef01234567",
    worktreePath: ".",
    contract: {
      version: 1,
      contract_id: "contract-1",
      task_id: "TASK-001",
      title: "Session contract",
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
}

function passingReport(runId: string): ReviewerReport {
  return {
    version: 1,
    run_id: runId,
    target_commit: "0123456789abcdef0123456789abcdef01234567",
    reviewer_verdict: "PASS",
    requirement_results: [
      {
        requirement_id: "AC-CORE",
        result: "PASS",
        evidence_level: "E1",
        evidence_paths: [],
        finding_ids: [],
      },
    ],
    findings: [],
    requested_human_decisions: [],
    requested_probes: [],
    notes: [],
  };
}

test("review sessions are fresh per run and persist report before archive", async () => {
  const root = await mkdtemp(join(process.cwd(), ".test-reviewer-session-"));
  const artifacts = new ArtifactStore(
    resolveAcceptanceHome(join(root, "home")),
  );
  const sessions = new ReviewerSessionManager(
    artifacts,
    () => "2026-08-27T00:00:00.000Z",
  );
  const active = sessions.start({
    projectId: "project",
    taskId: "TASK-001",
    runId: "RUN-001",
    provider: "fake",
  });
  assert.throws(() => sessions.cleanup(active.id), /before report persistence/);
  const service = new ReviewerService(sessions);
  const first = service.review(
    context("RUN-001"),
    new FakeReviewerProvider(passingReport("RUN-001")),
  );
  const second = service.review(
    context("RUN-002"),
    new FakeReviewerProvider(passingReport("RUN-002")),
  );
  assert.notEqual(first.session.id, second.session.id);
  assert.equal(first.session.status, "ARCHIVED");
  assert.equal(second.session.status, "ARCHIVED");
  const persisted = await readFile(
    join(
      artifacts.runRoot("project", "TASK-001", "RUN-001"),
      "reviewer",
      "report.json",
    ),
    "utf8",
  );
  assert.match(persisted, /RUN-001/);
  await rm(root, { recursive: true, force: true });
});
