import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
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
    const invocation = resolveInvocation(executable, args);
    const started = Date.now();
    const result = spawnSync(invocation.executable, invocation.args, {
      cwd: options.cwd,
      env: sanitizedEnvironment({
        ...options.env,
        ...(process.platform === "win32"
          ? {
              npm_config_cache: join(options.cwd, ".cap-npm-cache"),
              npm_config_update_notifier: "false",
            }
          : {}),
      }),
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
      executable: invocation.executable,
      args: invocation.args,
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
    "ComSpec",
    "COMSPEC",
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

function resolveInvocation(
  executable: string,
  args: string[],
): { executable: string; args: string[] } {
  if (process.platform !== "win32") return { executable, args };
  const normalized = executable.toLowerCase();
  if (
    normalized !== "npm" &&
    normalized !== "npm.cmd" &&
    normalized !== "npx" &&
    normalized !== "npx.cmd"
  )
    return { executable, args };
  const cliName = normalized.startsWith("npx") ? "npx-cli.js" : "npm-cli.js";
  const cliPath = join(
    dirname(process.execPath),
    "node_modules",
    "npm",
    "bin",
    cliName,
  );
  if (!existsSync(cliPath)) return { executable, args };
  return { executable: process.execPath, args: [cliPath, ...args] };
}
