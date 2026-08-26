import assert from "node:assert/strict";
import test from "node:test";
import { adversarialScenarios, assessRisk } from "../../src/risk.js";

test("risk policy lowers automation and adds human triggers for high-risk work", () => {
  const low = assessRisk({ riskLevel: "R0", runId: "RUN-LOW" });
  assert.equal(low.automation_level, "A4");
  assert.deepEqual(low.human_triggers, []);
  const high = assessRisk({
    riskLevel: "R3",
    runId: "RUN-HIGH",
    securitySensitive: true,
    releaseRequested: true,
  });
  assert.equal(high.automation_level, "A0");
  assert.ok(high.human_triggers.includes("HIGH_RISK"));
  assert.ok(high.human_triggers.includes("SECURITY_SENSITIVE"));
  assert.ok(high.human_triggers.includes("RELEASE_GATE"));
});

test("human sampling and adversarial probes are deterministic", () => {
  assert.equal(
    assessRisk({
      riskLevel: "R1",
      runId: "RUN-SAMPLED",
      policy: {
        version: 1,
        default_automation: { R0: "A4", R1: "A3", R2: "A2", R3: "A0" },
        security_requires_human: true,
        release_requires_human: true,
        sampling_percent: 100,
      },
    }).sampled,
    true,
  );
  const scenarios = adversarialScenarios("R2");
  assert.ok(
    scenarios.some((scenario) => scenario.id === "ADV-MISSING-EVIDENCE"),
  );
  assert.ok(
    scenarios.some((scenario) => scenario.id === "ADV-SECRET-EXPOSURE"),
  );
});
