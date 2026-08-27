import { StateTransitionError } from "./errors.js";
import type { RunStatus, TaskStatus } from "./domain.js";

const taskTransitions: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  BUILDING: ["READY_FOR_REVIEW", "CANCELLED"],
  READY_FOR_REVIEW: ["IN_ACCEPTANCE"],
  IN_ACCEPTANCE: [
    "ACCEPTED",
    "READY_FOR_REVIEW",
    "FIX_REQUESTED",
    "NEEDS_HUMAN",
    "BLOCKED",
    "CANCELLED",
  ],
  ACCEPTED: [],
  FIX_REQUESTED: ["FIXING"],
  FIXING: ["READY_FOR_REVIEW", "CANCELLED"],
  NEEDS_HUMAN: ["ACCEPTED", "FIX_REQUESTED", "BLOCKED"],
  BLOCKED: ["READY_FOR_REVIEW"],
  CANCELLED: [],
};

const runTransitions: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  CREATED: ["VALIDATING", "BLOCKED", "CANCELLED"],
  VALIDATING: ["PREPARING", "INVALID", "INFRA_FAILED", "CANCELLED"],
  PREPARING: ["VERIFYING", "INFRA_FAILED", "CANCELLED"],
  INVALID: [],
  VERIFYING: ["REVIEWING", "GATING", "INFRA_FAILED", "CANCELLED"],
  REVIEWING: ["GATING", "INFRA_FAILED", "CANCELLED"],
  GATING: ["COMPLETED_PASS", "COMPLETED_FAIL", "COMPLETED_HUMAN"],
  INFRA_FAILED: [],
  BLOCKED: [],
  COMPLETED_PASS: [],
  COMPLETED_FAIL: [],
  COMPLETED_HUMAN: [],
  CANCELLED: [],
};

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return taskTransitions[from].includes(to);
}

export function canTransitionRun(from: RunStatus, to: RunStatus): boolean {
  return runTransitions[from].includes(to);
}

export function transitionTask(from: TaskStatus, to: TaskStatus): TaskStatus {
  if (!canTransitionTask(from, to))
    throw new StateTransitionError("task", from, to);
  return to;
}

export function transitionRun(from: RunStatus, to: RunStatus): RunStatus {
  if (!canTransitionRun(from, to))
    throw new StateTransitionError("run", from, to);
  return to;
}

export function taskTransitionTable(): typeof taskTransitions {
  return taskTransitions;
}

export function runTransitionTable(): typeof runTransitions {
  return runTransitions;
}
