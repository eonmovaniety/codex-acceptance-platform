import { spawnSync } from "node:child_process";
import { CapError } from "./errors.js";

export interface CommandResult {
  command: string;
  executable: string;
  args: string[];
  exitCode: number | null;
  signal?: string;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface CommandRunOptions {
  cwd: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

export interface CommandRunner {
  run(command: string, options: CommandRunOptions): CommandResult;
}

export function tokenizeCommand(command: string): string[] {
  if (!command.trim())
    throw new CapError("Command must not be empty", "COMMAND_INVALID");
  if (/[;&|<>`\n\r]/.test(command)) {
    throw new CapError(
      "Shell operators are not allowed in generic commands",
      "COMMAND_UNSAFE",
    );
  }
  const tokens: string[] = [];
  const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(command)) !== null) {
    const value = match[1] ?? match[2] ?? match[3];
    if (value !== undefined) tokens.push(value.replaceAll('\\"', '"'));
  }
  if (tokens.length === 0)
    throw new CapError("Command must contain an executable", "COMMAND_INVALID");
  return tokens;
}

export class LocalCommandRunner implements CommandRunner {
  run(command: string, options: CommandRunOptions): CommandResult {
    const tokens = tokenizeCommand(command);
    const executable = tokens[0];
    if (!executable)
      throw new CapError(
        "Command must contain an executable",
        "COMMAND_INVALID",
      );
    const args = tokens.slice(1);
    const started = Date.now();
    const result = spawnSync(executable, args, {
      cwd: options.cwd,
      env: sanitizedEnvironment(options.env),
      encoding: "utf8",
      timeout: options.timeoutMs ?? 300_000,
      windowsHide: true,
      shell: false,
    });
    const processError = result.error as NodeJS.ErrnoException | undefined;
    const timedOut = processError?.code === "ETIMEDOUT";
    const output = typeof result.stdout === "string" ? result.stdout : "";
    const errorOutput =
      typeof result.stderr === "string"
        ? result.stderr
        : (processError?.message ?? "");
    return {
      command,
      executable,
      args,
      exitCode: timedOut ? null : result.status,
      ...(result.signal === null || result.signal === undefined
        ? {}
        : { signal: String(result.signal) }),
      stdout: output,
      stderr: errorOutput,
      durationMs: Date.now() - started,
      timedOut,
    };
  }
}

export function sanitizedEnvironment(
  additions?: Record<string, string | undefined>,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  const allowlist = [
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "TEMP",
    "TMP",
    "HOME",
    "USERPROFILE",
    "JAVA_HOME",
    "ANDROID_HOME",
    "ANDROID_SDK_ROOT",
  ];
  for (const key of allowlist) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  for (const [key, value] of Object.entries(additions ?? {})) {
    if (value === undefined) delete environment[key];
    else environment[key] = value;
  }
  for (const secret of [
    "CODEX_API_KEY",
    "OPENAI_API_KEY",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
  ]) {
    delete environment[secret];
  }
  return environment;
}
