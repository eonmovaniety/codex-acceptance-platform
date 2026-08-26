import type { ArtifactStore } from "./artifacts.js";
import type { EvidenceLevel } from "./domain.js";
import type { ReviewerReport } from "./review.js";
import type { VerifierResult } from "./verifier.js";

export type EvidenceSource = "verifier" | "reviewer" | "system" | "human";
export type EvidenceKind =
  | "test-report"
  | "log"
  | "command-result"
  | "screenshot"
  | "finding"
  | "target-integrity"
  | "review-report"
  | "other";

export interface EvidenceRecord {
  id: string;
  run_id: string;
  requirement_id?: string;
  source: EvidenceSource;
  kind: EvidenceKind;
  path: string;
  level: EvidenceLevel;
  exists: boolean;
  description?: string;
}

export interface EvidenceIndex {
  version: 1;
  run_id: string;
  records: EvidenceRecord[];
}

export interface EvidenceIndexContext {
  projectId: string;
  taskId: string;
  runId: string;
  artifacts: ArtifactStore;
  verifierResults: VerifierResult[];
  reviewerReport?: ReviewerReport;
}

export class EvidenceIndexBuilder {
  build(context: EvidenceIndexContext): EvidenceIndex {
    const records: EvidenceRecord[] = [];
    for (const verifier of context.verifierResults) {
      for (const [index, evidence] of verifier.evidence.entries()) {
        records.push(
          this.record(context, {
            source: "verifier",
            kind: evidence.kind,
            path: evidence.path,
            level: evidence.level ?? "E1",
            description: `${verifier.verifier}:${verifier.stage}:${String(index + 1)}`,
          }),
        );
      }
    }
    const report = context.reviewerReport;
    if (report) {
      records.push(
        this.record(context, {
          source: "reviewer",
          kind: "review-report",
          path: "reviewer/report.json",
          level: "E1",
          description: "Structured reviewer report",
        }),
      );
      for (const result of report.requirement_results) {
        for (const path of result.evidence_paths) {
          records.push(
            this.record(context, {
              source: "reviewer",
              requirement_id: result.requirement_id,
              kind: "other",
              path,
              level: result.evidence_level,
              description: `Reviewer evidence for ${result.requirement_id}`,
            }),
          );
        }
      }
      for (const finding of report.findings) {
        for (const path of finding.evidence_paths) {
          records.push(
            this.record(context, {
              source: "reviewer",
              requirement_id: finding.requirement_id,
              kind: "finding",
              path,
              level: "E2",
              description: `Finding ${finding.id}`,
            }),
          );
        }
      }
    }
    return {
      version: 1,
      run_id: context.runId,
      records: deduplicate(records),
    };
  }

  write(context: EvidenceIndexContext): EvidenceIndex {
    const index = this.build(context);
    context.artifacts.writeJson(
      context.projectId,
      context.taskId,
      context.runId,
      "evidence/index.json",
      index,
    );
    return index;
  }

  private record(
    context: EvidenceIndexContext,
    input: Omit<EvidenceRecord, "id" | "run_id" | "exists">,
  ): EvidenceRecord {
    return {
      id: `EVID-${String(context.runId)}-${String(input.path)}-${String(input.requirement_id ?? "run")}`,
      run_id: context.runId,
      ...input,
      exists: context.artifacts.exists(
        context.projectId,
        context.taskId,
        context.runId,
        input.path,
      ),
    };
  }
}

export function evidenceForRequirement(
  index: EvidenceIndex,
  requirementId: string,
): EvidenceRecord[] {
  return index.records.filter(
    (record) => record.requirement_id === requirementId && record.exists,
  );
}

function deduplicate(records: EvidenceRecord[]): EvidenceRecord[] {
  const seen = new Set<string>();
  return records.filter((record) => {
    const key = `${record.requirement_id ?? ""}|${record.path}|${record.level}|${record.source}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
