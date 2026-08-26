import { createHash } from "node:crypto";
import type { RiskLevel } from "./domain.js";

export type AutomationLevel = "A0" | "A1" | "A2" | "A3" | "A4";

export interface RiskPolicy {
  version: 1;
  default_automation: Record<RiskLevel, AutomationLevel>;
  security_requires_human: boolean;
  release_requires_human: boolean;
  sampling_percent: number;
}

export const defaultRiskPolicy: RiskPolicy = {
  version: 1,
  default_automation: {
    R0: "A4",
    R1: "A3",
    R2: "A2",
    R3: "A0",
  },
  security_requires_human: true,
  release_requires_human: true,
  sampling_percent: 10,
};

export interface RiskAssessment {
  risk_level: RiskLevel;
  automation_level: AutomationLevel;
  human_triggers: string[];
  sampled: boolean;
}

export function assessRisk(input: {
  riskLevel: RiskLevel;
  runId: string;
  policy?: RiskPolicy;
  securitySensitive?: boolean;
  releaseRequested?: boolean;
}): RiskAssessment {
  const policy = input.policy ?? defaultRiskPolicy;
  const humanTriggers: string[] = [];
  if (input.securitySensitive && policy.security_requires_human)
    humanTriggers.push("SECURITY_SENSITIVE");
  if (input.releaseRequested && policy.release_requires_human)
    humanTriggers.push("RELEASE_GATE");
  if (input.riskLevel === "R3") humanTriggers.push("HIGH_RISK");
  const sampled = shouldSample(input.runId, policy.sampling_percent);
  if (sampled) humanTriggers.push("HUMAN_SAMPLING");
  return {
    risk_level: input.riskLevel,
    automation_level: policy.default_automation[input.riskLevel],
    human_triggers: [...new Set(humanTriggers)].sort(),
    sampled,
  };
}

export function shouldSample(runId: string, percent: number): boolean {
  if (percent <= 0) return false;
  if (percent >= 100) return true;
  const digest = createHash("sha256").update(runId, "utf8").digest();
  const bucket = digest.readUInt16BE(0) % 100;
  return bucket < percent;
}

export interface AdversarialScenario {
  id: string;
  title: string;
  risk: RiskLevel;
  expected: "FAIL" | "HUMAN";
  probes: string[];
}

export function adversarialScenarios(risk: RiskLevel): AdversarialScenario[] {
  const base: AdversarialScenario[] = [
    {
      id: "ADV-MISSING-EVIDENCE",
      title: "PASS claim without an artifact",
      risk,
      expected: "FAIL",
      probes: ["Remove one referenced evidence artifact", "Rebuild the matrix"],
    },
    {
      id: "ADV-TARGET-DRIFT",
      title: "Reviewer target drift",
      risk,
      expected: "HUMAN",
      probes: ["Change worktree HEAD", "Run target integrity check"],
    },
  ];
  if (risk === "R2" || risk === "R3")
    base.push({
      id: "ADV-SECRET-EXPOSURE",
      title: "Sensitive value appears in reviewer context",
      risk,
      expected: "HUMAN",
      probes: ["Scan context and artifacts for token-shaped values"],
    });
  return base;
}
