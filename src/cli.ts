import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const helpText = `Codex Acceptance Platform (CAP)

Usage:
  acceptance <command> [options]

Commands:
  init                         Initialize global CAP state
  doctor                       Check local prerequisites
  project add <path>           Register a target project
  project validate <project>   Validate project configuration
  contract validate <file>     Validate an acceptance contract
  acceptance submit            Submit an immutable target commit
  run start|status|logs        Manage an acceptance run
  findings list <run>          List structured findings
  artifacts open <run>         Show run artifacts
  human list|show|decide       Manage human-gate requests
  cleanup                      Clean managed resources only
  history <project>            Show project history

Phase 0 status: bootstrap only. Later commands are intentionally not enabled yet.
`;

export function parseArgs(argv: readonly string[]): {
  command?: string;
  args: string[];
} {
  const [command, ...args] = argv;
  return command === undefined ? { args } : { command, args };
}

export function main(argv = process.argv.slice(2)): void {
  const { command } = parseArgs(argv);
  if (
    !command ||
    command === "--help" ||
    command === "-h" ||
    command === "help"
  ) {
    console.log(helpText);
    return;
  }
  console.error(`Command '${command}' is not available before Phase 1.`);
  process.exitCode = 2;
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  main();
}
