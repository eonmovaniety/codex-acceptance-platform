import assert from "node:assert/strict";
import test from "node:test";
import { helpText, parseArgs } from "../../src/cli.js";

test("Phase 0 CLI skeleton parses a command without mutating state", () => {
  assert.deepEqual(parseArgs(["doctor", "--json"]), {
    command: "doctor",
    args: ["--json"],
  });
});

test("Phase 0 CLI skeleton exposes the documented CLI surface", () => {
  assert.match(helpText, /acceptance submit/);
  assert.match(helpText, /Phase 0 status/);
});
