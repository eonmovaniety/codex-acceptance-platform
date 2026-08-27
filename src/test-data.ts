import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { ProjectConfig } from "./domain.js";
import { CapError } from "./errors.js";
import type { CommandRunner } from "./runner.js";

export const testDataLayers = ["base", "scenario", "edge", "visual"] as const;
export type TestDataLayer = (typeof testDataLayers)[number];

export interface TestDataStage {
  name: "reset" | "seed";
  result: "PASS" | "NOT_CONFIGURED";
  command?: string;
}

export interface TestDataManifest {
  version: 1;
  run_id: string;
  data_version: string;
  root: string;
  layers: TestDataLayer[];
  fresh_database: boolean;
  stages: TestDataStage[];
  marker_path: string;
}

export interface TestDataContext {
  runId: string;
  runtimePath: string;
  config: ProjectConfig;
  runner: CommandRunner;
  now?: () => string;
}

const markerName = ".cap-test-data.json";

export class TestDataManager {
  prepare(context: TestDataContext): TestDataManifest {
    const runtimeRoot = resolve(context.runtimePath);
    const root = resolve(runtimeRoot, "test-data");
    assertContained(runtimeRoot, root);
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    for (const layer of testDataLayers)
      mkdirSync(join(root, layer), { recursive: true });
    const stages: TestDataStage[] = [];
    const reset = context.config.test_data?.reset_command;
    if (reset) {
      this.runStage(context, root, "reset", reset);
      stages.push({ name: "reset", result: "PASS", command: reset });
    } else stages.push({ name: "reset", result: "NOT_CONFIGURED" });
    const seed = context.config.test_data?.seed_command;
    if (seed) {
      this.runStage(context, root, "seed", seed);
      stages.push({ name: "seed", result: "PASS", command: seed });
    } else stages.push({ name: "seed", result: "NOT_CONFIGURED" });
    const manifest: TestDataManifest = {
      version: 1,
      run_id: context.runId,
      data_version: context.config.test_data?.version ?? "v1",
      root,
      layers: [...testDataLayers],
      fresh_database: true,
      stages,
      marker_path: join(root, markerName),
    };
    writeFileSync(
      join(root, markerName),
      `${JSON.stringify({ marker: markerName, created_at: context.now?.() ?? new Date().toISOString(), ...manifest }, null, 2)}\n`,
      "utf8",
    );
    return manifest;
  }

  destroy(manifest: TestDataManifest): void {
    const root = resolve(manifest.root);
    assertContained(resolve(root, ".."), root);
    if (!existsSync(manifest.marker_path))
      throw new CapError(
        `Test data marker is missing: ${manifest.marker_path}`,
        "INVALID_MARKER",
      );
    const marker = JSON.parse(readFileSync(manifest.marker_path, "utf8")) as {
      marker?: string;
      run_id?: string;
    };
    if (marker.marker !== markerName || marker.run_id !== manifest.run_id)
      throw new CapError(
        `Test data marker does not match run ${manifest.run_id}`,
        "MARKER_MISMATCH",
      );
    rmSync(root, { recursive: true, force: true });
  }

  private runStage(
    context: TestDataContext,
    root: string,
    stage: "reset" | "seed",
    command: string,
  ): void {
    const result = context.runner.run(command, {
      cwd: root,
      timeoutMs: (context.config.runtime?.timeout_seconds ?? 300) * 1000,
      env: {
        CAP_ACCEPTANCE_RUN_ID: context.runId,
        CAP_TEST_DATA_STAGE: stage,
        CAP_TEST_DATA_VERSION: context.config.test_data?.version ?? "v1",
        CAP_AUTOMATION_RUN: "1",
      },
    });
    if (result.timedOut || result.exitCode !== 0)
      throw new CapError(
        `Test data ${stage} command failed: ${command}`,
        "TEST_DATA_INFRA_FAILED",
      );
  }
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
      `Test data path is outside managed runtime: ${candidate}`,
      "PATH_OUTSIDE_MANAGED_ROOT",
    );
}
