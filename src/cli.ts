import { existsSync } from "node:fs";
import { access, lstat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type { ProjectConfig, RiskLevel, Task } from "./domain.js";
import { ArtifactStore } from "./artifacts.js";
import {
  loadAcceptanceContract,
  loadProjectConfig,
  projectConfigPath,
} from "./config.js";
import { AcceptanceController } from "./controller.js";
import { CapError } from "./errors.js";
import { CliGitClient } from "./git.js";
import {
  databasePath,
  ensureAcceptanceHome,
  resolveAcceptanceHome,
  type AcceptanceHomePaths,
} from "./paths.js";
import { SqliteStore, systemClock } from "./storage.js";
import { AcceptanceRunExecutor } from "./orchestrator.js";
import {
  CodexCliReviewerProvider,
  FakeReviewerProvider,
  type ReviewerProvider,
} from "./review.js";
import { DashboardApi, DashboardServer } from "./dashboard.js";
import { BaselineStore } from "./visual.js";

export const helpText = `Codex Acceptance Platform (CAP)

Usage:
  acceptance <command> [options]

Commands:
  init                         Initialize global CAP state
  doctor                       Check local prerequisites
  project add <path>           Register a target project
  project validate <project>   Validate project configuration
  contract validate <file>     Validate an acceptance contract
  task create <project> <id>   Register a task
  acceptance submit            Submit an immutable target commit
  run start|execute|status|logs Manage an acceptance run
  fix start <project> <task>  Start a Builder fix cycle from FIX_REQUESTED
  dashboard serve              Serve the read-only local Dashboard API
  findings list <run>          List structured findings
  artifacts open <run>         Show run artifacts
  human list|show|decide       Manage human-gate requests
  cleanup                      Clean managed resources only
  history <project>            Show project history

Global options:
  --home <path>                Override the CAP state directory
  --json                       Emit machine-readable JSON where supported

Phase 7 status: isolated verification, policy-aware review, evidence matrix, dashboard, and deterministic gate.
`;

export interface ParsedArgs {
  command?: string;
  args: string[];
}

export interface ParsedOptions {
  positionals: string[];
  values: Record<string, string | boolean>;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const [command, ...args] = argv;
  return command === undefined ? { args } : { command, args };
}

export function parseOptions(args: readonly string[]): ParsedOptions {
  const positionals: string[] = [];
  const values: Record<string, string | boolean> = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token?.startsWith("--")) {
      if (token !== undefined) positionals.push(token);
      continue;
    }
    const withoutPrefix = token.slice(2);
    const equalsIndex = withoutPrefix.indexOf("=");
    if (equalsIndex >= 0) {
      values[withoutPrefix.slice(0, equalsIndex)] = withoutPrefix.slice(
        equalsIndex + 1,
      );
      continue;
    }
    const next = args[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      values[withoutPrefix] = next;
      index += 1;
    } else {
      values[withoutPrefix] = true;
    }
  }
  return { positionals, values };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { command, args } = parseArgs(argv);
  if (
    !command ||
    command === "--help" ||
    command === "-h" ||
    command === "help"
  ) {
    console.log(helpText);
    return;
  }

  const { positionals, values } = parseOptions(args);
  const home = resolveAcceptanceHome(asString(values.home));

  try {
    switch (command) {
      case "init":
        await handleInit(home, values.json === true);
        return;
      case "doctor":
        await handleDoctor(home, values.json === true);
        return;
      case "project":
        await handleProject(positionals, home, values.json === true);
        return;
      case "contract":
        await handleContract(positionals, values.json === true);
        return;
      case "task":
        await handleTask(positionals, values, home);
        return;
      case "acceptance":
      case "submit":
        await handleSubmit(positionals, values, home);
        return;
      case "run":
        await handleRun(positionals, values, home);
        return;
      case "fix":
        await handleFix(positionals, values, home);
        return;
      case "dashboard":
        await handleDashboard(positionals, values, home);
        return;
      case "human":
        await handleHuman(positionals, values, home);
        return;
      case "findings":
        await handleFindings(positionals, values, home);
        return;
      case "artifacts":
        await handleArtifacts(positionals, values, home);
        return;
      case "history":
        await handleHistory(positionals, home);
        return;
      default:
        throw new CapError(
          `Command '${command}' is not available`,
          "UNKNOWN_COMMAND",
        );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`CAP_ERROR: ${message}`);
    process.exitCode = 1;
  }
}

async function handleInit(
  home: AcceptanceHomePaths,
  asJson: boolean,
): Promise<void> {
  await ensureAcceptanceHome(home);
  const store = new SqliteStore(databasePath(home));
  store.close();
  print(
    { home: home.root, database: databasePath(home), initialized: true },
    asJson,
  );
}

async function handleDoctor(
  home: AcceptanceHomePaths,
  asJson: boolean,
): Promise<void> {
  const major = Number(process.versions.node.split(".")[0]);
  const checks = {
    node: { version: process.versions.node, pass: major >= 24 },
    sqlite: await checkSqlite(),
    git: checkGit(),
  };
  const pass = Object.values(checks).every((check) => check.pass);
  print({ pass, home: home.root, checks }, asJson);
  if (!pass) process.exitCode = 1;
}

async function checkSqlite(): Promise<{ pass: boolean; detail: string }> {
  try {
    const db = new DatabaseSync(":memory:");
    db.exec("SELECT 1");
    db.close();
    return { pass: true, detail: "node:sqlite" };
  } catch (error) {
    return {
      pass: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function checkGit(): { pass: boolean; detail: string } {
  try {
    return { pass: true, detail: new CliGitClient().version() };
  } catch (error) {
    return {
      pass: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function handleProject(
  positionals: string[],
  home: AcceptanceHomePaths,
  asJson: boolean,
): Promise<void> {
  const [subcommand, value] = positionals;
  if (subcommand === "add") {
    if (!value)
      throw new CapError(
        "Usage: acceptance project add <path>",
        "ARGUMENT_ERROR",
      );
    const configPath = await resolveProjectConfig(value);
    const config = await loadProjectConfig(configPath);
    await ensureAcceptanceHome(home);
    const store = new SqliteStore(databasePath(home));
    try {
      const project = new AcceptanceController({
        store,
        git: new CliGitClient(),
      }).registerProject(config, configPath);
      print(project, asJson);
    } finally {
      store.close();
    }
    return;
  }
  if (subcommand === "validate") {
    if (!value)
      throw new CapError(
        "Usage: acceptance project validate <path-or-project-id>",
        "ARGUMENT_ERROR",
      );
    if (await pathExists(value)) {
      const configPath = await resolveProjectConfig(value);
      print(await loadProjectConfig(configPath), asJson);
      return;
    }
    const store = new SqliteStore(databasePath(home));
    try {
      const controller = new AcceptanceController({
        store,
        git: new CliGitClient(),
      });
      const project = controller.getProjectOrThrow(value);
      print(await loadProjectConfig(project.configPath), asJson);
    } finally {
      store.close();
    }
    return;
  }
  throw new CapError(
    "Usage: acceptance project add|validate ...",
    "ARGUMENT_ERROR",
  );
}

async function handleContract(
  positionals: string[],
  asJson: boolean,
): Promise<void> {
  if (positionals[0] !== "validate" || !positionals[1]) {
    throw new CapError(
      "Usage: acceptance contract validate <file>",
      "ARGUMENT_ERROR",
    );
  }
  print(await loadAcceptanceContract(resolve(positionals[1])), asJson);
}

async function handleTask(
  positionals: string[],
  values: ParsedOptions["values"],
  home: AcceptanceHomePaths,
): Promise<void> {
  if (positionals[0] !== "create" || !positionals[1] || !positionals[2]) {
    throw new CapError(
      "Usage: acceptance task create <project-id> <task-id> --title <title>",
      "ARGUMENT_ERROR",
    );
  }
  const title = asString(values.title);
  if (!title) throw new CapError("--title is required", "ARGUMENT_ERROR");
  const projectId = positionals[1];
  const taskId = positionals[2];
  const store = new SqliteStore(databasePath(home));
  try {
    const project = new AcceptanceController({
      store,
      git: new CliGitClient(),
    }).getProjectOrThrow(projectId);
    if (store.findTask(project.id, taskId))
      throw new CapError(`Task '${taskId}' already exists`, "TASK_EXISTS");
    const now = systemClock.now();
    const task: Task = {
      id: taskId,
      projectId,
      title,
      status: "BUILDING",
      riskLevel: parseRisk(asString(values.risk)),
      failureCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    print(store.createTask(task), values.json === true);
  } finally {
    store.close();
  }
}

async function handleSubmit(
  positionals: string[],
  values: ParsedOptions["values"],
  home: AcceptanceHomePaths,
): Promise<void> {
  const projectId = asString(values.project);
  const taskId = asString(values.task);
  const commit = asString(values.commit);
  const contractPath = asString(values.contract) ?? positionals[0];
  if (!projectId || !taskId || !commit || !contractPath) {
    throw new CapError(
      "Usage: acceptance submit --project <id> --task <id> --commit <sha> --contract <file>",
      "ARGUMENT_ERROR",
    );
  }
  const store = new SqliteStore(databasePath(home));
  try {
    const controller = new AcceptanceController({
      store,
      git: new CliGitClient(),
    });
    const project = controller.getProjectOrThrow(projectId);
    const config = await loadProjectConfig(project.configPath);
    const contract = await loadAcceptanceContract(resolve(contractPath));
    if (contract.task_id !== taskId)
      throw new CapError(
        "--task does not match contract.task_id",
        "CONTRACT_TASK_MISMATCH",
      );
    const result = controller.submit(
      project,
      config,
      contract,
      resolve(contractPath),
      commit,
    );
    print({ existing: result.existing, run: result.run }, values.json === true);
  } finally {
    store.close();
  }
}

async function handleRun(
  positionals: string[],
  values: ParsedOptions["values"],
  home: AcceptanceHomePaths,
): Promise<void> {
  const [subcommand, runId] = positionals;
  if (!subcommand || !runId)
    throw new CapError(
      "Usage: acceptance run start|status|logs <run-id>",
      "ARGUMENT_ERROR",
    );
  const store = new SqliteStore(databasePath(home));
  try {
    const controller = new AcceptanceController({
      store,
      git: new CliGitClient(),
    });
    if (subcommand === "status") {
      print(store.getRun(runId), values.json === true);
    } else if (subcommand === "logs") {
      print(store.listEvents(runId), values.json === true);
    } else if (subcommand === "start") {
      print(controller.startRun(runId), values.json === true);
    } else if (subcommand === "execute") {
      const forcedProvider = createForcedProvider(asString(values.provider));
      const result = await new AcceptanceRunExecutor({
        store,
        home,
        git: new CliGitClient(),
        ...(forcedProvider
          ? {
              reviewerProviderFactory: ({
                schemaPath,
              }: {
                schemaPath: string;
              }) =>
                forcedProvider === "codex"
                  ? new CodexCliReviewerProvider({ schemaPath })
                  : new FakeReviewerProvider(),
            }
          : {}),
        reviewerSchemaPath: findReviewerSchemaPath(),
      }).execute(runId);
      print(result, values.json === true);
    } else {
      throw new CapError(
        `Unknown run subcommand '${subcommand}'`,
        "ARGUMENT_ERROR",
      );
    }
  } finally {
    store.close();
  }
}

function createForcedProvider(
  value: string | undefined,
): "fake" | "codex" | undefined {
  if (value === undefined) return undefined;
  if (value === "fake" || value === "codex") return value;
  throw new CapError(`Invalid reviewer provider '${value}'`, "ARGUMENT_ERROR");
}

function findReviewerSchemaPath(): string {
  const candidates = [
    resolve(process.cwd(), "schemas", "reviewer-report.schema.json"),
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "schemas",
      "reviewer-report.schema.json",
    ),
  ];
  return (
    candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!
  );
}

async function handleHistory(
  positionals: string[],
  home: AcceptanceHomePaths,
): Promise<void> {
  if (!positionals[0])
    throw new CapError(
      "Usage: acceptance history <project-id>",
      "ARGUMENT_ERROR",
    );
  const store = new SqliteStore(databasePath(home));
  try {
    console.log(JSON.stringify(store.listRuns(positionals[0]), null, 2));
  } finally {
    store.close();
  }
}

async function handleFix(
  positionals: string[],
  values: ParsedOptions["values"],
  home: AcceptanceHomePaths,
): Promise<void> {
  if (positionals[0] !== "start" || !positionals[1] || !positionals[2])
    throw new CapError(
      "Usage: acceptance fix start <project-id> <task-id>",
      "ARGUMENT_ERROR",
    );
  const store = new SqliteStore(databasePath(home));
  try {
    const task = new AcceptanceController({
      store,
      git: new CliGitClient(),
    }).beginFix(positionals[1], positionals[2]);
    print(task, values.json === true);
  } finally {
    store.close();
  }
}

async function handleDashboard(
  positionals: string[],
  values: ParsedOptions["values"],
  home: AcceptanceHomePaths,
): Promise<void> {
  if (positionals[0] !== "serve")
    throw new CapError(
      "Usage: acceptance dashboard serve [--port <port>]",
      "ARGUMENT_ERROR",
    );
  const portValue = asString(values.port);
  const port = portValue === undefined ? 4173 : Number(portValue);
  if (!Number.isInteger(port) || port < 0 || port > 65_535)
    throw new CapError(
      `Invalid dashboard port '${portValue}'`,
      "ARGUMENT_ERROR",
    );
  const store = new SqliteStore(databasePath(home));
  const server = new DashboardServer(
    new DashboardApi(store, new ArtifactStore(home), home),
  );
  const actualPort = await server.listen(port);
  console.log(`CAP dashboard API: http://127.0.0.1:${String(actualPort)}`);
  await new Promise<void>((resolve) => {
    const stop = async (): Promise<void> => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      await server.close();
      store.close();
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

async function handleHuman(
  positionals: string[],
  values: ParsedOptions["values"],
  home: AcceptanceHomePaths,
): Promise<void> {
  const baselineStore = new BaselineStore(home);
  const [subcommand, requestId] = positionals;
  if (subcommand === "list") {
    print(baselineStore.listRequests(), values.json === true);
    return;
  }
  if (subcommand === "show" && requestId) {
    print(baselineStore.getRequest(requestId), values.json === true);
    return;
  }
  if (subcommand === "decide" && requestId) {
    const choices = [
      values.approve === true,
      values.reject === true,
      values.defer === true,
    ].filter(Boolean).length;
    if (choices !== 1)
      throw new CapError(
        "Choose exactly one of --approve, --reject, or --defer",
        "ARGUMENT_ERROR",
      );
    const result =
      values.approve === true
        ? baselineStore.approveFromArtifact(requestId, new ArtifactStore(home))
        : values.reject === true
          ? baselineStore.reject(requestId)
          : baselineStore.defer(requestId);
    print(result, values.json === true);
    return;
  }
  throw new CapError(
    "Usage: acceptance human list|show <request-id>|decide <request-id> --approve|--reject|--defer",
    "ARGUMENT_ERROR",
  );
}

async function handleFindings(
  positionals: string[],
  values: ParsedOptions["values"],
  home: AcceptanceHomePaths,
): Promise<void> {
  if (positionals[0] !== "list" || !positionals[1])
    throw new CapError(
      "Usage: acceptance findings list <run-id>",
      "ARGUMENT_ERROR",
    );
  const store = new SqliteStore(databasePath(home));
  try {
    const run = store.getRun(positionals[1]);
    const artifacts = new ArtifactStore(home);
    const findings = artifacts.exists(
      run.projectId,
      run.taskId,
      run.id,
      "reviewer/report.json",
    )
      ? ((
          JSON.parse(
            artifacts.readText(
              run.projectId,
              run.taskId,
              run.id,
              "reviewer/report.json",
            ),
          ) as { findings?: unknown[] }
        ).findings ?? [])
      : [];
    print(findings, values.json === true);
  } finally {
    store.close();
  }
}

async function handleArtifacts(
  positionals: string[],
  values: ParsedOptions["values"],
  home: AcceptanceHomePaths,
): Promise<void> {
  if (positionals[0] !== "open" || !positionals[1])
    throw new CapError(
      "Usage: acceptance artifacts open <run-id>",
      "ARGUMENT_ERROR",
    );
  const store = new SqliteStore(databasePath(home));
  try {
    const run = store.getRun(positionals[1]);
    print(
      new ArtifactStore(home).listRelativePaths(
        run.projectId,
        run.taskId,
        run.id,
      ),
      values.json === true,
    );
  } finally {
    store.close();
  }
}

async function resolveProjectConfig(value: string): Promise<string> {
  const candidate = resolve(value);
  const stats = await lstat(candidate);
  if (stats.isFile()) return candidate;
  if (!stats.isDirectory())
    throw new CapError(
      `Project path is not a directory or file: ${candidate}`,
      "PROJECT_PATH_INVALID",
    );
  return projectConfigPath(candidate);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(resolve(path));
    return true;
  } catch {
    return false;
  }
}

function parseRisk(value: string | undefined): RiskLevel {
  if (value === undefined) return "R1";
  if (value === "R0" || value === "R1" || value === "R2" || value === "R3")
    return value;
  throw new CapError(`Invalid risk level '${value}'`, "ARGUMENT_ERROR");
}

function asString(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function print(value: unknown, asJson: boolean): void {
  console.log(asJson ? JSON.stringify(value) : JSON.stringify(value, null, 2));
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  await main();
}
