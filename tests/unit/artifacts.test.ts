import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { ArtifactStore } from "../../src/artifacts.js";
import { resolveAcceptanceHome } from "../../src/paths.js";

test("artifact store hashes a finalized run and rejects later writes", async () => {
  const root = await mkdtemp(join(process.cwd(), ".test-artifact-"));
  const home = resolveAcceptanceHome(join(root, "cap-home"));
  const artifacts = new ArtifactStore(home, () => "2026-08-27T00:00:00.000Z");
  artifacts.writeText(
    "project",
    "TASK-001",
    "RUN-001",
    "logs/build.log",
    "build ok\n",
  );
  artifacts.writeJson(
    "project",
    "TASK-001",
    "RUN-001",
    "verifier/result.json",
    { result: "PASS" },
  );
  assert.throws(
    () =>
      artifacts.writeText(
        "project",
        "TASK-001",
        "RUN-001",
        "..\\outside.txt",
        "must fail",
      ),
    /escapes/,
  );

  const manifest = artifacts.finalize("project", "TASK-001", "RUN-001");
  assert.equal(manifest.version, 1);
  assert.equal(manifest.run_id, "RUN-001");
  assert.equal(manifest.artifacts.length, 2);
  assert.ok(
    manifest.artifacts.every((entry) => /^[0-9a-f]{64}$/.test(entry.sha256)),
  );
  assert.equal(
    artifacts.finalize("project", "TASK-001", "RUN-001").finalized_at,
    manifest.finalized_at,
  );
  assert.throws(
    () =>
      artifacts.writeText(
        "project",
        "TASK-001",
        "RUN-001",
        "late.txt",
        "must fail",
      ),
    /finalized/,
  );
  await rm(root, { recursive: true, force: true });
});
