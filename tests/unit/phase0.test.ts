import assert from "node:assert/strict";
import test from "node:test";
import { helpText, parseArgs } from "../../src/cli.js";

test("Phase 0 CLI skeleton parses a command without mutating state", () => {
  assert.deepEqual(parseArgs(["doctor", "--json"]), {
    command: "doctor",
    args: ["--json"],
  });
});

test("CAP CLI exposes the implemented acceptance surface", () => {
  assert.match(helpText, /acceptance submit/);
  assert.match(helpText, /run start\|execute\|status\|logs/);
  assert.match(helpText, /Phase 3 status/);
});
