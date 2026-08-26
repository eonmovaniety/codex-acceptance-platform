import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { ArtifactStore } from "../../src/artifacts.js";
import {
  PixelDiff,
  BaselineStore,
  DeterministicVisualAdapter,
  ScreenshotCaptureService,
  type VisualCase,
} from "../../src/visual.js";
import { resolveAcceptanceHome } from "../../src/paths.js";

const visualCase: VisualCase = {
  version: 1,
  case_id: "settings",
  route: "/settings",
  states: ["empty", "loading", "error", "max-content"],
  viewports: [{ id: "phone", width: 3, height: 2, dpr: 1 }],
};

test("visual capture covers four states and is pixel-stable for the same inputs", async () => {
  const root = await mkdtemp(join(process.cwd(), ".test-visual-"));
  const artifacts = new ArtifactStore(
    resolveAcceptanceHome(join(root, "home")),
  );
  const service = new ScreenshotCaptureService(artifacts);
  const first = service.captureCase({
    projectId: "project",
    taskId: "TASK-001",
    runId: "RUN-001",
    testDataVersion: "v1",
    visualCase,
    adapter: new DeterministicVisualAdapter("web"),
  });
  const second = service.captureCase({
    projectId: "project",
    taskId: "TASK-001",
    runId: "RUN-002",
    testDataVersion: "v1",
    visualCase,
    adapter: new DeterministicVisualAdapter("web"),
  });
  assert.equal(first.screenshots.length, 4);
  assert.deepEqual(
    first.screenshots.map((screenshot) => screenshot.sha256),
    second.screenshots.map((screenshot) => screenshot.sha256),
  );
  const changedData = service.captureCase({
    projectId: "project",
    taskId: "TASK-001",
    runId: "RUN-003",
    testDataVersion: "v2",
    visualCase,
    adapter: new DeterministicVisualAdapter("web"),
  });
  assert.notEqual(
    first.screenshots[0]?.sha256,
    changedData.screenshots[0]?.sha256,
  );
  const android = new DeterministicVisualAdapter("android").capture({
    visualCase,
    state: "empty",
    viewport: visualCase.viewports[0]!,
    testDataVersion: "v1",
  });
  assert.equal(android.platform, "android");
  assert.equal(new PixelDiff().compare(android, android).same, true);
  await rm(root, { recursive: true, force: true });
});

test("baseline changes create a Human request and never overwrite without approval", async () => {
  const root = await mkdtemp(join(process.cwd(), ".test-baseline-"));
  const home = resolveAcceptanceHome(join(root, "home"));
  const artifacts = new ArtifactStore(home);
  const baselineStore = new BaselineStore(
    home,
    () => "2026-08-27T00:00:00.000Z",
  );
  const adapter = new DeterministicVisualAdapter("web");
  const frameV1 = adapter.capture({
    visualCase,
    state: "empty",
    viewport: visualCase.viewports[0]!,
    testDataVersion: "v1",
  });
  const missing = baselineStore.compare({
    projectId: "project",
    frame: frameV1,
    candidateArtifact: "visual/settings/empty/phone.rgba",
  });
  assert.equal(missing.status, "HUMAN_REQUIRED");
  assert.equal(missing.request?.reason, "MISSING_BASELINE");
  const requestId = missing.request?.request_id;
  assert.ok(requestId);
  baselineStore.approve(requestId, frameV1);
  assert.equal(
    baselineStore.compare({
      projectId: "project",
      frame: frameV1,
      candidateArtifact: "visual/settings/empty/phone.rgba",
    }).status,
    "MATCH",
  );
  const baselinePath = missing.request!.baseline_path;
  const before = await readFile(baselinePath);
  const frameV2 = adapter.capture({
    visualCase,
    state: "empty",
    viewport: visualCase.viewports[0]!,
    testDataVersion: "v2",
  });
  const changed = baselineStore.compare({
    projectId: "project",
    frame: frameV2,
    candidateArtifact: "visual/settings/empty/phone.rgba",
  });
  assert.equal(changed.status, "HUMAN_REQUIRED");
  assert.equal(changed.request?.reason, "BASELINE_CHANGE");
  assert.deepEqual(await readFile(baselinePath), before);
  assert.ok(artifacts.runRoot("project", "TASK-001", "RUN-001"));
  await rm(root, { recursive: true, force: true });
});
