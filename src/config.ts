import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse } from "yaml";
import type { AcceptanceContract, ProjectConfig } from "./domain.js";
import { validateDocument } from "./validation.js";
import type { VisualCase } from "./visual.js";

export async function readYamlFile(path: string): Promise<unknown> {
  const content = await readFile(path, "utf8");
  return parse(content);
}

export async function loadProjectConfig(path: string): Promise<ProjectConfig> {
  const value = validateDocument<ProjectConfig>(
    "project",
    await readYamlFile(path),
  );
  return value;
}

export async function loadAcceptanceContract(
  path: string,
): Promise<AcceptanceContract> {
  return validateDocument<AcceptanceContract>(
    "acceptance-contract",
    await readYamlFile(path),
  );
}

export async function loadVisualCase(path: string): Promise<VisualCase> {
  return validateDocument<VisualCase>("visual-case", await readYamlFile(path));
}

export async function sha256File(path: string): Promise<string> {
  const content = await readFile(path);
  return createHash("sha256").update(content).digest("hex");
}

export function sha256FileSync(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function projectConfigPath(projectPath: string): string {
  return resolve(projectPath, ".acceptance", "project.yaml");
}
