import assert from "node:assert/strict";
import test from "node:test";
import { LocalCommandRunner, tokenizeCommand } from "../../src/runner.js";

test("command tokenizer rejects shell composition", () => {
  assert.deepEqual(tokenizeCommand('node -e "process.exit(0)"'), [
    "node",
    "-e",
    "process.exit(0)",
  ]);
  assert.throws(
    () => tokenizeCommand("node script.js | more"),
    /Shell operators/,
  );
});

test("local command runner captures exit code and output", () => {
  const runner = new LocalCommandRunner();
  const result = runner.run("node -e \"process.stdout.write('ok')\"", {
    cwd: process.cwd(),
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "ok");
  assert.equal(result.timedOut, false);
});
