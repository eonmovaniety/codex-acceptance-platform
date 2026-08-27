import { createHash, randomUUID } from "node:crypto";
import type { Clock } from "./storage.js";

export function createRunId(
  clock: Clock = { now: () => new Date().toISOString() },
): string {
  const date = clock.now().slice(0, 10).replaceAll("-", "");
  return `RUN-${date}-${randomUUID().slice(0, 8).toUpperCase()}`;
}

export function createIdempotencyKey(
  projectId: string,
  taskId: string,
  targetCommit: string,
  contractHash: string,
  testDataVersion = "v1",
  gatePolicyVersion = "v1",
  executionScope = "local",
): string {
  return createHash("sha256")
    .update(
      [
        projectId,
        taskId,
        targetCommit,
        contractHash,
        testDataVersion,
        gatePolicyVersion,
        executionScope,
      ].join("\n"),
      "utf8",
    )
    .digest("hex");
}

export function createRetryIdempotencyKey(
  baseKey: string,
  attempt: number,
): string {
  return createHash("sha256")
    .update([baseKey, "retry", String(attempt)].join("\n"), "utf8")
    .digest("hex");
}
