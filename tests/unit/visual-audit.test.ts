import assert from "node:assert/strict";
import test from "node:test";
import { VisualTokenGeometryAuditor } from "../../src/visual-audit.js";

test("visual token and geometry mismatches become structured findings", () => {
  const result = new VisualTokenGeometryAuditor().audit({
    expectedTokens: { colorPrimary: "#00ff00", spacing: 8 },
    observedTokens: { colorPrimary: "#ff0000", spacing: 8 },
    expectedGeometry: { width: 320, height: 640 },
    observedGeometry: { width: 320, height: 600 },
  });
  assert.equal(result.result, "FAIL");
  assert.equal(result.findings.length, 2);
  assert.ok(result.findings.some((finding) => finding.kind === "TOKEN"));
  assert.ok(result.findings.some((finding) => finding.kind === "GEOMETRY"));
});
