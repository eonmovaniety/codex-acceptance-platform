import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { join, normalize, relative, resolve, sep } from "node:path";
import { CapError } from "./errors.js";
import type { AcceptanceHomePaths } from "./paths.js";

export interface ArtifactEntry {
  path: string;
  sha256: string;
  sizeBytes: number;
}

export interface ArtifactManifest {
  version: 1;
  run_id: string;
  finalized_at: string;
  artifacts: ArtifactEntry[];
}

function assertRelativeArtifactPath(path: string): string {
  if (!path || path.includes("\0"))
    throw new CapError("Artifact path is invalid", "ARTIFACT_PATH_INVALID");
  const normalized = normalize(path);
  if (
    normalized.startsWith("..") ||
    normalized.startsWith(sep) ||
    /^[A-Za-z]:/.test(normalized)
  ) {
    throw new CapError(
      `Artifact path escapes the run directory: ${path}`,
      "ARTIFACT_PATH_INVALID",
    );
  }
  return normalized;
}

function collectFiles(root: string, directory = root): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectFiles(root, path));
    else if (entry.isFile() && entry.name !== ".finalized") files.push(path);
  }
  return files;
}

export class ArtifactStore {
  constructor(
    private readonly home: AcceptanceHomePaths,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  runRoot(projectId: string, taskId: string, runId: string): string {
    const root = resolve(this.home.projects, projectId, "runs", taskId, runId);
    const relativePath = relative(resolve(this.home.projects), root);
    if (relativePath.startsWith("..") || relativePath.startsWith(sep)) {
      throw new CapError(
        "Artifact run path escapes CAP project storage",
        "ARTIFACT_PATH_INVALID",
      );
    }
    return root;
  }

  ensureRun(projectId: string, taskId: string, runId: string): string {
    const root = this.runRoot(projectId, taskId, runId);
    mkdirSync(root, { recursive: true });
    return root;
  }

  writeText(
    projectId: string,
    taskId: string,
    runId: string,
    relativePath: string,
    content: string,
  ): string {
    const root = this.ensureRun(projectId, taskId, runId);
    this.assertWritable(root);
    const safePath = assertRelativeArtifactPath(relativePath);
    const path = resolve(root, safePath);
    if (!path.startsWith(`${root}${sep}`))
      throw new CapError(
        "Artifact path escapes run directory",
        "ARTIFACT_PATH_INVALID",
      );
    mkdirSync(resolve(path, ".."), { recursive: true });
    writeFileSync(path, content, "utf8");
    return path;
  }

  writeJson(
    projectId: string,
    taskId: string,
    runId: string,
    relativePath: string,
    value: unknown,
  ): string {
    return this.writeText(
      projectId,
      taskId,
      runId,
      relativePath,
      `${JSON.stringify(value, null, 2)}\n`,
    );
  }

  readText(
    projectId: string,
    taskId: string,
    runId: string,
    relativePath: string,
  ): string {
    const root = this.runRoot(projectId, taskId, runId);
    const safePath = assertRelativeArtifactPath(relativePath);
    const path = resolve(root, safePath);
    if (!path.startsWith(`${root}${sep}`))
      throw new CapError(
        "Artifact path escapes run directory",
        "ARTIFACT_PATH_INVALID",
      );
    return readFileSync(path, "utf8");
  }

  isFinalized(projectId: string, taskId: string, runId: string): boolean {
    return existsSync(
      join(this.runRoot(projectId, taskId, runId), ".finalized"),
    );
  }

  finalize(projectId: string, taskId: string, runId: string): ArtifactManifest {
    const root = this.ensureRun(projectId, taskId, runId);
    if (this.isFinalized(projectId, taskId, runId)) {
      return JSON.parse(
        this.readText(projectId, taskId, runId, "artifact-manifest.json"),
      ) as ArtifactManifest;
    }
    const artifacts: ArtifactEntry[] = collectFiles(root)
      .filter((path) => relative(root, path) !== "artifact-manifest.json")
      .map((path) => {
        const content = readFileSync(path);
        return {
          path: relative(root, path).replaceAll(sep, "/"),
          sha256: createHash("sha256").update(content).digest("hex"),
          sizeBytes: statSync(path).size,
        };
      })
      .sort((left, right) => left.path.localeCompare(right.path));
    const manifest: ArtifactManifest = {
      version: 1,
      run_id: runId,
      finalized_at: this.now(),
      artifacts,
    };
    this.writeJson(
      projectId,
      taskId,
      runId,
      "artifact-manifest.json",
      manifest,
    );
    writeFileSync(
      join(root, ".finalized"),
      `${manifest.finalized_at}\n`,
      "utf8",
    );
    return manifest;
  }

  private assertWritable(root: string): void {
    if (existsSync(join(root, ".finalized")))
      throw new CapError(
        `Run artifacts are finalized: ${root}`,
        "ARTIFACTS_FINALIZED",
      );
  }
}
