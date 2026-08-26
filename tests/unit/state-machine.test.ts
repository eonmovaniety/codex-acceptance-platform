import assert from "node:assert/strict";
import test from "node:test";
import { StateTransitionError } from "../../src/errors.js";
import {
  canTransitionRun,
  canTransitionTask,
  transitionRun,
  transitionTask,
} from "../../src/state-machine.js";

test("task state machine accepts the documented happy path", () => {
  let status = transitionTask("BUILDING", "READY_FOR_REVIEW");
  status = transitionTask(status, "IN_ACCEPTANCE");
  status = transitionTask(status, "FIX_REQUESTED");
  status = transitionTask(status, "FIXING");
  status = transitionTask(status, "READY_FOR_REVIEW");
  assert.equal(status, "READY_FOR_REVIEW");
});

test("task state machine rejects skipping the controller", () => {
  assert.equal(canTransitionTask("BUILDING", "ACCEPTED"), false);
  assert.throws(
    () => transitionTask("BUILDING", "ACCEPTED"),
    StateTransitionError,
  );
});

test("run state machine accepts completion only from gating", () => {
  assert.equal(canTransitionRun("GATING", "COMPLETED_PASS"), true);
  assert.equal(canTransitionRun("CREATED", "COMPLETED_PASS"), false);
  assert.throws(
    () => transitionRun("CREATED", "COMPLETED_PASS"),
    StateTransitionError,
  );
});

test("run state machine keeps terminal states terminal", () => {
  assert.equal(canTransitionRun("COMPLETED_FAIL", "CREATED"), false);
  assert.equal(canTransitionRun("INFRA_FAILED", "VERIFYING"), false);
});
