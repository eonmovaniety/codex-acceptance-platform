import type { ProjectConfig } from "../domain.js";
import { CapError } from "../errors.js";
import { validateDocument } from "../validation.js";
import {
  aggregateVerifierResults,
  GenericCommandAdapter,
  type AcceptanceAdapter,
  type VerifierContext,
  type VerifierResult,
} from "../verifier.js";

export interface AtmosphereEngineCheck {
  id: string;
  result: "PASS" | "FAIL" | "BLOCKED" | "NOT_TESTED";
  detail?: string;
}

export interface AtmosphereEngineReport {
  version: 1;
  adapter: "atmosphere-engine";
  target_commit: string;
  engine: {
    name: string;
    version: string;
    contract_version: string;
  };
  target: {
    target_id: string;
    platform: string;
    product: string;
  };
  result: "PASS" | "FAIL" | "BLOCKED";
  checks: AtmosphereEngineCheck[];
  runtime: {
    apply_status: "applied" | "degraded";
    applied_revision: number;
    same_plan_status: "noop";
    stale_revision_status: "superseded";
    rollback_status: "rejected";
    rollback_event_observed: boolean;
    preview_isolated: boolean;
    event_types: string[];
  };
  limitations: string[];
}

const defaultBridgeCommand = "node .acceptance/cap-runtime-probe.mjs --json";

export class AtmosphereEngineAdapter implements AcceptanceAdapter {
  run(context: VerifierContext): VerifierResult[] {
    const bridgeCommand = bridgeCommandFor(context.config);
    const effectiveConfig: ProjectConfig = {
      ...context.config,
      commands: {
        setup: context.config.commands?.setup ?? [
          "npm ci --ignore-scripts --no-audit --no-fund",
        ],
        build: context.config.commands?.build ?? ["npm run build"],
        lint: context.config.commands?.lint ?? ["npm run studio:typecheck"],
        unit: context.config.commands?.unit ?? ["npm test"],
        integration: ensureBridge(
          context.config.commands?.integration ?? [],
          bridgeCommand,
        ),
        ...(context.config.commands?.e2e === undefined
          ? {}
          : { e2e: context.config.commands.e2e }),
      },
    };
    const generic = new GenericCommandAdapter({
      verifierName: "atmosphere-engine",
    });
    const results = generic.run({ ...context, config: effectiveConfig });
    const integrationCommands = effectiveConfig.commands?.integration ?? [];
    const bridgeIndex = integrationCommands.indexOf(bridgeCommand);
    const bridgeResult = results.find(
      (result) =>
        result.stage === "integration" && result.command === bridgeCommand,
    );
    if (!bridgeResult || bridgeIndex < 0) return results;
    const bridgeResultPath = `verifier/integration/${String(bridgeIndex + 1).padStart(2, "0")}.result.json`;
    if (bridgeResult.result === "PASS") {
      this.attachBridgeReport(
        context,
        bridgeResult,
        bridgeResultPath,
        bridgeIndex,
        bridgeCommand,
      );
    }
    context.artifacts.writeJson(
      context.projectId,
      context.taskId,
      context.runId,
      "verifier/summary.json",
      {
        version: 1,
        run_id: context.runId,
        result: aggregateVerifierResults(results),
        stages: results,
      },
    );
    return results;
  }

  private attachBridgeReport(
    context: VerifierContext,
    bridgeResult: VerifierResult,
    bridgeResultPath: string,
    bridgeIndex: number,
    bridgeCommand: string,
  ): void {
    const stdoutPath = `verifier/integration/${String(bridgeIndex + 1).padStart(2, "0")}.stdout.log`;
    let report: AtmosphereEngineReport;
    try {
      report = validateDocument<AtmosphereEngineReport>(
        "atmosphere-engine-report",
        JSON.parse(
          context.artifacts.readText(
            context.projectId,
            context.taskId,
            context.runId,
            stdoutPath,
          ),
        ) as unknown,
      );
      if (report.target_commit !== context.targetCommit) {
        throw new CapError(
          `Atmosphere Engine bridge target mismatch: expected ${context.targetCommit}, got ${report.target_commit}`,
          "ATMOSPHERE_ENGINE_TARGET_MISMATCH",
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      bridgeResult.result = "FAIL";
      bridgeResult.warnings = [
        ...bridgeResult.warnings,
        `Bridge report validation failed: ${message}`,
      ];
      context.artifacts.writeJson(
        context.projectId,
        context.taskId,
        context.runId,
        "engine/report-validation-error.json",
        {
          version: 1,
          command: bridgeCommand,
          stdout_path: stdoutPath,
          error: message,
        },
      );
      context.artifacts.writeJson(
        context.projectId,
        context.taskId,
        context.runId,
        bridgeResultPath,
        bridgeResult,
      );
      return;
    }

    const reportPath = context.artifacts.writeJson(
      context.projectId,
      context.taskId,
      context.runId,
      "engine/report.json",
      report,
    );
    void reportPath;
    bridgeResult.evidence.push({
      kind: "test-report",
      path: "engine/report.json",
      level: "E3",
    });
    if (report.result === "FAIL") bridgeResult.result = "FAIL";
    if (report.result === "BLOCKED") bridgeResult.result = "BLOCKED";
    if (report.result !== "PASS")
      bridgeResult.warnings = [
        ...bridgeResult.warnings,
        `Engine bridge reported ${report.result}`,
      ];
    context.artifacts.writeJson(
      context.projectId,
      context.taskId,
      context.runId,
      bridgeResultPath,
      bridgeResult,
    );
  }
}

function bridgeCommandFor(config: ProjectConfig): string {
  const value = config.adapter?.config?.bridge_command;
  if (value === undefined) return defaultBridgeCommand;
  if (typeof value !== "string" || value.trim().length === 0)
    throw new CapError(
      "Atmosphere Engine adapter bridge_command must be a non-empty string",
      "ATMOSPHERE_ENGINE_BRIDGE_INVALID",
    );
  return value;
}

function ensureBridge(commands: string[], bridgeCommand: string): string[] {
  return commands.includes(bridgeCommand)
    ? [...commands]
    : [...commands, bridgeCommand];
}
