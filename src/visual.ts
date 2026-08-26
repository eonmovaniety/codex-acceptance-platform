import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { ArtifactStore } from "./artifacts.js";
import type { AcceptanceHomePaths } from "./paths.js";
import { CapError } from "./errors.js";
import type { ReviewerFinding } from "./review.js";
import { validateDocument } from "./validation.js";
import {
  VisualTokenGeometryAuditor,
  type VisualAuditResult,
} from "./visual-audit.js";

export type VisualPlatform = "web" | "android";

export interface VisualViewport {
  id: string;
  width: number;
  height: number;
  dpr?: number;
}

export interface VisualAuditSpec {
  expected_tokens: Record<string, string | number>;
  observed_tokens: Record<string, string | number>;
  expected_geometry?: Record<string, number>;
  observed_geometry?: Record<string, number>;
  requirement_id?: string;
}

export interface VisualCase {
  version: 1;
  case_id: string;
  route: string;
  states: string[];
  viewports: VisualViewport[];
  requirement_id?: string;
  audit?: VisualAuditSpec;
}

export interface VisualFrame {
  platform: VisualPlatform;
  caseId: string;
  state: string;
  viewport: VisualViewport;
  rgba: Buffer;
}

export interface VisualCaptureInput {
  visualCase: VisualCase;
  state: string;
  viewport: VisualViewport;
  testDataVersion: string;
}

export interface VisualCaptureAdapter {
  readonly platform: VisualPlatform;
  capture(input: VisualCaptureInput): VisualFrame;
}

export class DeterministicVisualAdapter implements VisualCaptureAdapter {
  constructor(public readonly platform: VisualPlatform) {}

  capture(input: VisualCaptureInput): VisualFrame {
    if (input.viewport.width <= 0 || input.viewport.height <= 0)
      throw new CapError(
        `Visual viewport must be positive: ${input.viewport.id}`,
        "VISUAL_VIEWPORT_INVALID",
      );
    const seed = createHash("sha256")
      .update(
        JSON.stringify({
          platform: this.platform,
          case_id: input.visualCase.case_id,
          route: input.visualCase.route,
          state: input.state,
          viewport: input.viewport,
          test_data_version: input.testDataVersion,
        }),
      )
      .digest();
    const rgba = Buffer.alloc(input.viewport.width * input.viewport.height * 4);
    for (let index = 0; index < rgba.length; index += 1)
      rgba[index] = seed[index % seed.length]! ^ (index % 251);
    return {
      platform: this.platform,
      caseId: input.visualCase.case_id,
      state: input.state,
      viewport: input.viewport,
      rgba,
    };
  }
}

export interface PixelDiffResult {
  same: boolean;
  width: number;
  height: number;
  changed_pixels: number;
  total_pixels: number;
  changed_ratio: number;
  reason: string;
}

export class PixelDiff {
  compare(
    expected: VisualFrame,
    actual: VisualFrame,
    channelThreshold = 0,
  ): PixelDiffResult {
    const width = expected.viewport.width;
    const height = expected.viewport.height;
    const totalPixels = width * height;
    if (
      expected.viewport.width !== actual.viewport.width ||
      expected.viewport.height !== actual.viewport.height ||
      expected.rgba.length !== actual.rgba.length
    ) {
      return {
        same: false,
        width,
        height,
        changed_pixels: totalPixels,
        total_pixels: totalPixels,
        changed_ratio: 1,
        reason: "viewport-or-pixel-buffer-size-changed",
      };
    }
    let changedPixels = 0;
    for (let pixel = 0; pixel < totalPixels; pixel += 1) {
      const offset = pixel * 4;
      let changed = false;
      for (let channel = 0; channel < 4; channel += 1) {
        if (
          Math.abs(
            expected.rgba[offset + channel]! - actual.rgba[offset + channel]!,
          ) > channelThreshold
        ) {
          changed = true;
          break;
        }
      }
      if (changed) changedPixels += 1;
    }
    return {
      same: changedPixels === 0,
      width,
      height,
      changed_pixels: changedPixels,
      total_pixels: totalPixels,
      changed_ratio: totalPixels === 0 ? 0 : changedPixels / totalPixels,
      reason: changedPixels === 0 ? "pixel-identical" : "pixel-difference",
    };
  }
}

export interface BaselineRequest {
  version: 1;
  request_id: string;
  project_id: string;
  task_id: string;
  run_id: string;
  case_id: string;
  state: string;
  viewport_id: string;
  platform: VisualPlatform;
  reason: "MISSING_BASELINE" | "BASELINE_CHANGE";
  candidate_artifact: string;
  baseline_path: string;
  width: number;
  height: number;
  status: "PENDING" | "APPROVED" | "REJECTED" | "DEFERRED";
  created_at: string;
  updated_at: string;
}

export interface BaselineComparison {
  status: "MATCH" | "HUMAN_REQUIRED";
  diff?: PixelDiffResult;
  request?: BaselineRequest;
}

export class BaselineStore {
  private readonly pixelDiff = new PixelDiff();

  constructor(
    private readonly home: AcceptanceHomePaths,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  compare(input: {
    projectId: string;
    taskId: string;
    runId: string;
    frame: VisualFrame;
    candidateArtifact: string;
  }): BaselineComparison {
    const baselinePath = this.baselinePath(
      input.projectId,
      input.frame.caseId,
      input.frame.state,
      input.frame.viewport.id,
    );
    if (!existsSync(baselinePath)) {
      return {
        status: "HUMAN_REQUIRED",
        request: this.createRequest(input, baselinePath, "MISSING_BASELINE"),
      };
    }
    const expected: VisualFrame = {
      ...input.frame,
      rgba: readFileSync(baselinePath),
    };
    const diff = this.pixelDiff.compare(expected, input.frame);
    if (diff.same) return { status: "MATCH", diff };
    return {
      status: "HUMAN_REQUIRED",
      diff,
      request: this.createRequest(input, baselinePath, "BASELINE_CHANGE"),
    };
  }

  approve(requestId: string, frame: VisualFrame): BaselineRequest {
    const request = this.getRequest(requestId);
    if (request.status !== "PENDING")
      throw new CapError(
        `Baseline request is not pending: ${requestId}`,
        "BASELINE_REQUEST_NOT_PENDING",
      );
    if (
      request.width !== frame.viewport.width ||
      request.height !== frame.viewport.height
    )
      throw new CapError(
        `Baseline dimensions do not match request ${requestId}`,
        "BASELINE_DIMENSION_MISMATCH",
      );
    assertContained(this.home.baselinesCache, request.baseline_path);
    mkdirSync(resolve(request.baseline_path, ".."), { recursive: true });
    writeFileSync(request.baseline_path, frame.rgba);
    const updated: BaselineRequest = {
      ...request,
      status: "APPROVED",
      updated_at: this.now(),
    };
    this.writeRequest(updated);
    return updated;
  }

  approveFromArtifact(
    requestId: string,
    artifacts: ArtifactStore,
  ): BaselineRequest {
    const request = this.getRequest(requestId);
    const rgba = artifacts.readBuffer(
      request.project_id,
      request.task_id,
      request.run_id,
      request.candidate_artifact,
    );
    return this.approve(requestId, {
      platform: request.platform,
      caseId: request.case_id,
      state: request.state,
      viewport: {
        id: request.viewport_id,
        width: request.width,
        height: request.height,
      },
      rgba,
    });
  }

  reject(requestId: string): BaselineRequest {
    const request = this.getRequest(requestId);
    if (request.status !== "PENDING")
      throw new CapError(
        `Baseline request is not pending: ${requestId}`,
        "BASELINE_REQUEST_NOT_PENDING",
      );
    const updated: BaselineRequest = {
      ...request,
      status: "REJECTED",
      updated_at: this.now(),
    };
    this.writeRequest(updated);
    return updated;
  }

  defer(requestId: string): BaselineRequest {
    const request = this.getRequest(requestId);
    if (request.status !== "PENDING")
      throw new CapError(
        `Baseline request is not pending: ${requestId}`,
        "BASELINE_REQUEST_NOT_PENDING",
      );
    const updated: BaselineRequest = {
      ...request,
      status: "DEFERRED",
      updated_at: this.now(),
    };
    this.writeRequest(updated);
    return updated;
  }

  listRequests(): BaselineRequest[] {
    const root = resolve(this.home.baselinesCache, "requests");
    if (!existsSync(root)) return [];
    return readdirSync(root)
      .filter((name) => name.endsWith(".json"))
      .map((name) =>
        validateDocument<BaselineRequest>(
          "baseline-request",
          JSON.parse(readFileSync(join(root, name), "utf8")) as unknown,
        ),
      )
      .sort((left, right) => left.created_at.localeCompare(right.created_at));
  }

  getRequest(requestId: string): BaselineRequest {
    assertSafeSegment(requestId);
    const path = resolve(
      this.home.baselinesCache,
      "requests",
      `${requestId}.json`,
    );
    assertContained(this.home.baselinesCache, path);
    if (!existsSync(path))
      throw new CapError(
        `Baseline request not found: ${requestId}`,
        "BASELINE_REQUEST_NOT_FOUND",
      );
    return validateDocument<BaselineRequest>(
      "baseline-request",
      JSON.parse(readFileSync(path, "utf8")) as unknown,
    );
  }

  private createRequest(
    input: {
      projectId: string;
      taskId: string;
      runId: string;
      frame: VisualFrame;
      candidateArtifact: string;
    },
    baselinePath: string,
    reason: BaselineRequest["reason"],
  ): BaselineRequest {
    const request: BaselineRequest = {
      version: 1,
      request_id: `BASE-${randomUUID().slice(0, 8).toUpperCase()}`,
      project_id: input.projectId,
      task_id: input.taskId,
      run_id: input.runId,
      case_id: input.frame.caseId,
      state: input.frame.state,
      viewport_id: input.frame.viewport.id,
      platform: input.frame.platform,
      reason,
      candidate_artifact: input.candidateArtifact,
      baseline_path: baselinePath,
      width: input.frame.viewport.width,
      height: input.frame.viewport.height,
      status: "PENDING",
      created_at: this.now(),
      updated_at: this.now(),
    };
    this.writeRequest(request);
    return request;
  }

  private writeRequest(request: BaselineRequest): void {
    const path = resolve(
      this.home.baselinesCache,
      "requests",
      `${request.request_id}.json`,
    );
    assertContained(this.home.baselinesCache, path);
    mkdirSync(resolve(path, ".."), { recursive: true });
    writeFileSync(path, `${JSON.stringify(request, null, 2)}\n`, "utf8");
  }

  private baselinePath(
    projectId: string,
    caseId: string,
    state: string,
    viewportId: string,
  ): string {
    for (const value of [projectId, caseId, state, viewportId])
      assertSafeSegment(value);
    const path = resolve(
      this.home.baselinesCache,
      projectId,
      caseId,
      state,
      `${viewportId}.rgba`,
    );
    assertContained(this.home.baselinesCache, path);
    return path;
  }
}

export interface ScreenshotRecord {
  case_id: string;
  state: string;
  viewport_id: string;
  platform: VisualPlatform;
  width: number;
  height: number;
  artifact_path: string;
  sha256: string;
}

export interface VisualCaptureResult {
  screenshots: ScreenshotRecord[];
  human_triggers: string[];
  baseline_requests: BaselineRequest[];
  audit_results: VisualAuditResult[];
  audit_findings: ReviewerFinding[];
}

export class ScreenshotCaptureService {
  constructor(private readonly artifacts: ArtifactStore) {}

  captureCase(input: {
    projectId: string;
    taskId: string;
    runId: string;
    testDataVersion: string;
    visualCase: VisualCase;
    adapter: VisualCaptureAdapter;
    baselineStore?: BaselineStore;
  }): VisualCaptureResult {
    const visualCase = validateDocument<VisualCase>(
      "visual-case",
      input.visualCase,
    );
    assertSafeSegment(visualCase.case_id);
    const screenshots: ScreenshotRecord[] = [];
    const humanTriggers: string[] = [];
    const baselineRequests: BaselineRequest[] = [];
    const auditResults: VisualAuditResult[] = [];
    const auditFindings: ReviewerFinding[] = [];
    if (visualCase.audit) {
      const audit = new VisualTokenGeometryAuditor().audit({
        expectedTokens: visualCase.audit.expected_tokens,
        observedTokens: visualCase.audit.observed_tokens,
        ...(visualCase.audit.expected_geometry
          ? { expectedGeometry: visualCase.audit.expected_geometry }
          : {}),
        ...(visualCase.audit.observed_geometry
          ? { observedGeometry: visualCase.audit.observed_geometry }
          : {}),
      });
      auditResults.push(audit);
      auditFindings.push(
        ...audit.findings.map((finding): ReviewerFinding => ({
          id: `${visualCase.case_id}-${finding.id}`,
          requirement_id:
            visualCase.audit?.requirement_id ??
            visualCase.requirement_id ??
            "VISUAL",
          severity: finding.severity,
          title: finding.title,
          description: `Expected ${finding.expected}; observed ${finding.observed}`,
          expected: finding.expected,
          observed: finding.observed,
          evidence_paths: [],
        })),
      );
    }
    for (const state of visualCase.states) {
      assertSafeSegment(state);
      for (const viewport of visualCase.viewports) {
        assertSafeSegment(viewport.id);
        const frame = input.adapter.capture({
          visualCase,
          state,
          viewport,
          testDataVersion: input.testDataVersion,
        });
        const base = `visual/${visualCase.case_id}/${state}/${viewport.id}`;
        const artifactPath = this.artifacts.writeBuffer(
          input.projectId,
          input.taskId,
          input.runId,
          `${base}.rgba`,
          frame.rgba,
        );
        this.artifacts.writeJson(
          input.projectId,
          input.taskId,
          input.runId,
          `${base}.json`,
          {
            version: 1,
            case_id: visualCase.case_id,
            route: visualCase.route,
            state,
            viewport,
            platform: frame.platform,
            artifact_path: `${base}.rgba`,
            sha256: createHash("sha256").update(frame.rgba).digest("hex"),
          },
        );
        screenshots.push({
          case_id: visualCase.case_id,
          state,
          viewport_id: viewport.id,
          platform: frame.platform,
          width: viewport.width,
          height: viewport.height,
          artifact_path: `${base}.rgba`,
          sha256: createHash("sha256").update(frame.rgba).digest("hex"),
        });
        if (input.baselineStore) {
          const comparison = input.baselineStore.compare({
            projectId: input.projectId,
            taskId: input.taskId,
            runId: input.runId,
            frame,
            candidateArtifact: `${base}.rgba`,
          });
          if (comparison.status === "HUMAN_REQUIRED") {
            humanTriggers.push(
              comparison.request?.reason === "MISSING_BASELINE"
                ? "BASELINE_MISSING"
                : "BASELINE_CHANGE",
            );
            if (comparison.request) baselineRequests.push(comparison.request);
          }
        }
      }
    }
    return {
      screenshots,
      human_triggers: [...new Set(humanTriggers)].sort(),
      baseline_requests: baselineRequests,
      audit_results: auditResults,
      audit_findings: auditFindings,
    };
  }
}

function assertSafeSegment(value: string): void {
  if (
    !value ||
    value === "." ||
    value === ".." ||
    !/^[A-Za-z0-9._-]+$/.test(value)
  )
    throw new CapError(
      `Unsafe visual path segment: ${value}`,
      "VISUAL_PATH_INVALID",
    );
}

function assertContained(root: string, candidate: string): void {
  const relativePath = relative(resolve(root), resolve(candidate));
  if (
    !relativePath ||
    relativePath.startsWith("..") ||
    relativePath.startsWith(sep) ||
    relativePath.startsWith("/")
  )
    throw new CapError(
      `Visual path is outside managed baseline root: ${candidate}`,
      "PATH_OUTSIDE_MANAGED_ROOT",
    );
}
