import type { Severity } from "./review.js";

export interface VisualAuditFinding {
  id: string;
  kind: "TOKEN" | "GEOMETRY";
  severity: Severity;
  title: string;
  expected: string;
  observed: string;
}

export interface VisualAuditResult {
  version: 1;
  result: "PASS" | "FAIL";
  findings: VisualAuditFinding[];
}

export class VisualTokenGeometryAuditor {
  audit(input: {
    expectedTokens: Record<string, string | number>;
    observedTokens: Record<string, string | number>;
    expectedGeometry?: Record<string, number>;
    observedGeometry?: Record<string, number>;
  }): VisualAuditResult {
    const findings: VisualAuditFinding[] = [];
    for (const [key, expected] of Object.entries(input.expectedTokens)) {
      const observed = input.observedTokens[key];
      if (observed === expected) continue;
      findings.push({
        id: `TOKEN-${key}`,
        kind: "TOKEN",
        severity: "S2",
        title: `Visual token mismatch: ${key}`,
        expected: String(expected),
        observed: observed === undefined ? "missing" : String(observed),
      });
    }
    for (const [key, expected] of Object.entries(
      input.expectedGeometry ?? {},
    )) {
      const observed = input.observedGeometry?.[key];
      if (observed === expected) continue;
      findings.push({
        id: `GEOMETRY-${key}`,
        kind: "GEOMETRY",
        severity: "S2",
        title: `Geometry mismatch: ${key}`,
        expected: String(expected),
        observed: observed === undefined ? "missing" : String(observed),
      });
    }
    return {
      version: 1,
      result: findings.length === 0 ? "PASS" : "FAIL",
      findings,
    };
  }
}
